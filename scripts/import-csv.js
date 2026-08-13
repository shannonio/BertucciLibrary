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
  const idx = (name) => header.indexOf(name);

  const iTitle = idx('title');
  const iAuthor = idx('author');
  const iGenre = idx('genre');
  const iSubject = idx('subject');
  const iSummary = idx('summary');

  if (iTitle === -1) {
    console.error(`CSV needs a "Title" column. Found: ${header.join(', ')}`);
    process.exit(1);
  }

  const findExisting = db.prepare(
    `SELECT id FROM items
     WHERE title = ? AND COALESCE(creator, '') = COALESCE(?, '')`
  );
  const updateExisting = db.prepare(
    `UPDATE items SET genre = ?, subject = ?, summary = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  );

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length < 2) continue;

      const title = (row[iTitle] || '').trim();
      if (!title) {
        skipped++;
        continue;
      }
      const creator = (row[iAuthor] || '').trim() || null;
      const genre = (row[iGenre] || '').trim() || null;
      const subject = (row[iSubject] || '').trim() || null;
      const summary = (row[iSummary] || '').trim() || null;

      const existing = findExisting.get(title, creator);
      if (existing) {
        updateExisting.run(genre, subject, summary, existing.id);
        updated++;
      } else {
        insertItem({
          kind: 'book',
          title,
          creator,
          genre,
          subject,
          summary,
          source: 'csv',
          enrich_state: 'pending',
        });
        inserted++;
      }
    }
  });

  run();

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
