/**
 * Index a Google Drive folder of digital curriculum into the catalog.
 *
 *   npm run drive                    # list what the service account can see
 *   npm run drive -- --find homeschool
 *   npm run drive -- --folder <id>
 *   npm run drive -- --folder <id> --no-text    # skip text extraction
 *   npm run drive -- --folder <id> --prune      # remove entries for deleted files
 *
 * Re-running is safe: files are matched on their Drive id, so an index refresh
 * updates existing entries rather than duplicating them.
 */
import 'dotenv/config';
import { db, outboxSize, insertItem, withOutboxSuppressed } from '../server/db.js';
import * as drive from '../server/drive.js';
import * as sheets from '../server/sheets.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] ?? true;
};

const FOLDER = flag('folder');
const FIND = flag('find');
const NO_TEXT = args.includes('--no-text');
const PRUNE = args.includes('--prune');
const DRY_RUN = args.includes('--dry-run');

// Folders to leave out, matched case-insensitively against any path segment.
// A curriculum folder usually also holds records about the children — reports,
// assessments, portfolios — and those shouldn't land in a searchable catalog
// that syncs to a spreadsheet and is read by an AI assistant.
const EXCLUDE = (flag('exclude') && flag('exclude') !== true
  ? String(flag('exclude')).split(',')
  : []
).map((s) => s.trim().toLowerCase()).filter(Boolean);

const isExcluded = (filePath) =>
  EXCLUDE.some((ex) => filePath.toLowerCase().split('/').some((seg) => seg.includes(ex)));

/**
 * File extensions to skip. Curriculum bundles downloaded as zips unpack into
 * hundreds of web assets — minified scripts, stylesheets, sprite images — which
 * are noise in a catalog. Always skipped: macOS's .DS_Store droppings.
 */
const EXCLUDE_EXT = new Set(
  (flag('exclude-ext') && flag('exclude-ext') !== true ? String(flag('exclude-ext')).split(',') : [])
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
);

/**
 * Structural junk, skipped regardless of flags:
 *   - macOS and Windows filesystem droppings
 *   - "Save Page As" sidecar folders. A browser saving `Lesson.html` writes a
 *     `Lesson_files/` folder of fonts, avatars, and site chrome beside it —
 *     never catalog content, and invisible to an extension filter because many
 *     of the files have no extension at all (`css2`).
 */
const ALWAYS_SKIP =
  /(^|\/)\.DS_Store$|(^|\/)Thumbs\.db$|(^|\/)__MACOSX(\/|$)|_files\//i;

const isJunk = (f) => {
  if (ALWAYS_SKIP.test(f.path)) return true;
  if (!EXCLUDE_EXT.size) return false;
  const ext = (f.name.match(/\.([A-Za-z0-9]{1,6})$/) || [, ''])[1].toLowerCase();
  return ext ? EXCLUDE_EXT.has(ext) : false;
};

if (!drive.isConfigured()) {
  console.error('\n  No service-account key found. Drive indexing is unavailable.\n');
  process.exit(1);
}

// --- discovery -------------------------------------------------------------

if (!FOLDER) {
  console.log('');
  try {
    if (FIND && FIND !== true) {
      const hits = await drive.findFolders(FIND);
      if (!hits.length) {
        console.log(`  No folder matching "${FIND}" is shared with the service account.\n`);
      } else {
        console.log(`  Folders matching "${FIND}":\n`);
        for (const f of hits) console.log(`    ${f.id}  ${f.name}`);
        console.log(`\n  Index one with:  npm run drive -- --folder <id>\n`);
      }
    } else {
      const shared = await drive.listShared();
      console.log(`  Shared with ${drive.serviceAccountEmail()}:\n`);
      if (!shared.length) {
        console.log('    (nothing yet)\n');
      } else {
        for (const f of shared) {
          const isDir = f.mimeType.includes('folder');
          console.log(`    ${isDir ? '[folder]' : '        '} ${f.id}  ${f.name}`);
        }
        console.log(`\n  Index a folder with:  npm run drive -- --folder <id>\n`);
      }
    }
  } catch (err) {
    console.error(`  ${err.message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// --- walk ------------------------------------------------------------------

console.log('\n  Reading the folder...\n');

let rootName;
let files;
try {
  const res = await drive.walk(FOLDER, {
    onProgress: (e) => {
      if (e.type === 'folder') process.stdout.write(`\r  scanning ${e.path.slice(0, 62).padEnd(64)}`);
      if (e.type === 'error') console.log(`\n  skipped ${e.path}: ${e.message.slice(0, 70)}`);
    },
  });
  rootName = res.rootName;
  files = res.files;
} catch (err) {
  console.error(`  ${err.message}\n`);
  process.exit(1);
}

process.stdout.write(`\r${' '.repeat(72)}\r`);

const excluded = files.filter((f) => isExcluded(f.path));
const junk = files.filter((f) => !isExcluded(f.path) && isJunk(f));
files = files.filter((f) => !isExcluded(f.path) && !isJunk(f));

console.log(
  `  "${rootName}" — ${files.length} file(s)` +
    (excluded.length ? `, ${excluded.length} excluded by folder` : '') +
    (junk.length ? `, ${junk.length} skipped by type` : '') +
    '\n'
);

if (DRY_RUN) {
  // Group by top-level folder so the shape of the collection is visible before
  // anything is written.
  const byTop = {};
  for (const f of files) {
    const top = f.folder.split('/')[1] || '(root)';
    (byTop[top] ||= []).push(f);
  }
  console.log('  Would index:\n');
  for (const [top, list] of Object.entries(byTop).sort((a, b) => b[1].length - a[1].length)) {
    const types = {};
    for (const f of list) types[f.typeLabel] = (types[f.typeLabel] || 0) + 1;
    const kinds = Object.entries(types).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${n} ${t}`).join(', ');
    console.log(`    ${String(list.length).padStart(4)}  ${top.padEnd(34)} ${kinds}`);
  }
  if (excluded.length) {
    const exTop = new Set(excluded.map((f) => f.folder.split('/')[1] || '(root)'));
    console.log(`\n  Excluded by folder (${excluded.length}): ${[...exTop].join(', ')}`);
  }
  if (junk.length) {
    const byExt = {};
    for (const f of junk) {
      const e = (f.name.match(/\.([A-Za-z0-9]{1,6})$/) || [, 'other'])[1].toLowerCase();
      byExt[e] = (byExt[e] || 0) + 1;
    }
    console.log(`  Skipped by type (${junk.length}): ` +
      Object.entries(byExt).sort((a, b) => b[1] - a[1]).map(([e, n]) => n + ' .' + e).join(', '));
  }
  console.log('\n  Nothing written. Drop --dry-run to index.\n');
  process.exit(0);
}

if (!files.length) {
  console.log('  Nothing to index.\n');
  process.exit(0);
}

// --- index -----------------------------------------------------------------

const findByDriveId = db.prepare(
  `SELECT id, summary FROM items WHERE external_id = ? AND kind = 'curriculum'`
);
const updateItem = db.prepare(
  `UPDATE items SET
     title = ?, subject = ?, genre = ?, file_path = ?, web_url = ?,
     summary = COALESCE(?, summary), updated_at = datetime('now')
   WHERE id = ?`
);

let added = 0;
let updated = 0;
let withText = 0;

for (const [i, f] of files.entries()) {
  process.stdout.write(
    `\r  [${String(Math.round(((i + 1) / files.length) * 100)).padStart(3)}%] ` +
      `${i + 1}/${files.length}  +${added} ~${updated}  ${f.name.slice(0, 34).padEnd(34)}`
  );

  // Folder names carry real meaning in a curriculum library — "Math/Grade 3/
  // Fractions" is the subject taxonomy. Index it so it's searchable.
  const folderBits = f.folder.split('/').filter(Boolean);
  const subject = folderBits.slice(1).join(', ') || folderBits[0] || null;

  const text = NO_TEXT ? null : await drive.extractText(f);
  if (text) withText++;

  // Drive-indexed files deliberately do NOT sync to the Sheet. Drive is already
  // their source of truth — re-running this script rebuilds them — and pushing
  // thousands of machine-generated rows would swamp the hand-curated catalog
  // and blow past the tab's row limit.
  withOutboxSuppressed(() => {
    const existing = findByDriveId.get(f.id);
    if (existing) {
      updateItem.run(f.name, subject, f.typeLabel, f.path, f.link, text, existing.id);
      updated++;
    } else {
      insertItem({
        kind: 'curriculum',
        title: f.name,
        subject,
        genre: f.typeLabel,
        file_path: f.path,
        web_url: f.link,
        external_id: f.id,
        summary: text,
        source: 'drive',
        enrich_state: 'ok',
      });
      added++;
    }
  });
}

console.log(`\n\n  Indexed — ${added} added, ${updated} updated.`);
if (!NO_TEXT) {
  console.log(`  Text extracted from ${withText} Google Docs/Slides/Sheets.`);
  const noText = files.length - withText;
  if (noText) {
    console.log(`  ${noText} file(s) indexed by name and folder only (PDFs, Office files).`);
  }
}

// --- prune -----------------------------------------------------------------

if (PRUNE) {
  const seen = new Set(files.map((f) => f.id));
  const stale = db
    .prepare(
      `SELECT id, title, external_id FROM items
       WHERE kind = 'curriculum' AND source = 'drive' AND external_id IS NOT NULL`
    )
    .all()
    .filter((r) => !seen.has(r.external_id));

  if (stale.length) {
    const del = db.prepare('DELETE FROM items WHERE id = ?');
    withOutboxSuppressed(() => { for (const s of stale) del.run(s.id); });
    console.log(`  Pruned ${stale.length} entr(ies) for files no longer in the folder.`);
  }
} else {
  console.log(`  (Files deleted from Drive stay listed. Use --prune to remove them.)`);
}

console.log('\n  These stay local — Drive is their source of truth, so they are not\n  pushed to the Sheet. Re-run this script to refresh them.\n');
