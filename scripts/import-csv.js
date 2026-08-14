/**
 * Import book_catalog.csv into the SQLite catalog.
 *
 * Idempotent: re-running matches on (title, creator) and updates rather than
 * duplicating, so you can re-import a corrected CSV without wiping enrichment.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { db, insertItem, outboxSize } from '../server/db.js';
import * as sheets from '../server/sheets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = process.argv[2] || path.join(here, '..', 'book_catalog.csv');

/** RFC 4180 CSV parser — handles quoted fields, escaped quotes, embedded newlines. */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV not found: ${CSV_PATH}`);
    process.exit(1);
  }

  const rows = parseCSV(fs.readFileSync(CSV_PATH, 'utf8'));
  const header = rows[0].map((h) => h.trim().toLowerCase());

  // Map CSV headings onto catalog fields. Several spellings per field so a
  // books export and a games export both import without editing anything.
  const FIELD_ALIASES = {
    title: ['title', 'name'],
    creator: ['author', 'creator', 'designer', 'publisher', 'artist'],
    genre: ['genre', 'type of game', 'type', 'category'],
    subject: ['subject', 'subjects', 'topic', 'topics'],
    summary: ['summary', 'description', 'blurb'],
    age_range: ['age rating', 'age range', 'ages', 'age'],
    players: ['player count', 'players', 'number of players'],
    play_time: ['length of game', 'play time', 'playing time', 'duration', 'length'],
    tags: ['tags', 'keywords'],
    location: ['location', 'where', 'shelf'],
    notes: ['notes', 'note'],
    isbn: ['isbn', 'isbn13', 'isbn-13'],
  };

  const colFor = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const i = header.findIndex((h) => aliases.includes(h));
    if (i !== -1) colFor[field] = i;
  }

  if (colFor.title === undefined) {
    console.error(`CSV needs a "Title" column. Found: ${header.join(', ')}`);
    process.exit(1);
  }

  // Infer what these rows are from the columns present, unless told otherwise.
  const kindArg = process.argv.find((a) => a.startsWith('--kind='));
  const kind =
    kindArg?.split('=')[1] ||
    (colFor.players !== undefined || header.includes('type of game')
      ? 'boardgame'
      : 'book');

  const cell = (row, field) => {
    const i = colFor[field];
    if (i === undefined) return null;
    const v = (row[i] || '').trim();
    return v === '' ? null : v;
  };

  // Match on title within the same kind, so a board game called "Dixit" and a
  // book of the same name can coexist.
  const findExisting = db.prepare(
    `SELECT id FROM items
     WHERE title = ? AND kind = ? AND COALESCE(creator, '') = COALESCE(?, '')`
  );

  const FILLABLE = [
    'creator', 'genre', 'subject', 'summary',
    'age_range', 'players', 'play_time', 'tags', 'location', 'notes', 'isbn',
  ];

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length < 2) continue;

      const title = cell(row, 'title');
      if (!title) {
        skipped++;
        continue;
      }

      const fields = {};
      for (const f of FILLABLE) {
        const v = cell(row, f);
        if (v !== null) fields[f] = v;
      }

      const existing = findExisting.get(title, kind, fields.creator ?? null);
      if (existing) {
        // Re-importing a corrected CSV should update, not duplicate — but
        // never blank out something the CSV simply doesn't carry.
        const present = Object.keys(fields);
        if (present.length) {
          const set = present.map((f) => `${f} = @${f}`).join(', ');
          db.prepare(
            `UPDATE items SET ${set}, updated_at = datetime('now') WHERE id = @id`
          ).run({ ...fields, id: existing.id });
        }
        updated++;
      } else {
        insertItem({
          kind,
          title,
          ...fields,
          source: 'csv',
          // Only books get ISBN/cover lookups; games have nothing to enrich.
          enrich_state: kind === 'book' ? 'pending' : 'ok',
        });
        inserted++;
      }
    }
  });

  run();
  console.log(`  detected kind: ${kind}`);
  console.log(`  mapped columns: ${Object.keys(colFor).join(', ')}`);

  const total = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  console.log(`Imported ${path.basename(CSV_PATH)}`);
  console.log(`  inserted: ${inserted}`);
  console.log(`  updated:  ${updated}`);
  if (skipped) console.log(`  skipped:  ${skipped} (no title)`);
  console.log(`  catalog now holds ${total} items`);
  console.log(`\nNext: npm run enrich   (fetches ISBNs + cover art)`);

  // Mirror the import into the Sheet in one batched call.
  if (sheets.isConfigured() && outboxSize()) {
    process.stdout.write(`\nPushing ${outboxSize()} change(s) to the Google Sheet... `);
    try {
      const r = await sheets.flushOutbox();
      console.log(`done (${r.updated} updated, ${r.appended} added).`);
    } catch (err) {
      console.log(`deferred: ${err.message}`);
    }
  }
}

await main();
