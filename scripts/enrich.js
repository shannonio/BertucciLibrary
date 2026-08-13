/**
 * Fill in ISBNs and cover art for catalog items that don't have them yet.
 *
 * Resumable: each item is marked ok / notfound / error as it completes, so
 * interrupting this (Ctrl-C) and re-running picks up where it stopped.
 *
 *   npm run enrich              # process pending items
 *   npm run enrich -- --retry   # also retry previous notfound/error
 *   npm run enrich -- --limit 50
 */
import 'dotenv/config';
import { db, outboxSize } from '../server/db.js';
import * as sheets from '../server/sheets.js';
import {
  lookupByTitle, lookupByIsbn, coverExists, googleByIsbn, coverFromIsbn,
  getProviderIssues,
} from '../server/lookup.js';

const args = process.argv.slice(2);
const RETRY = args.includes('--retry');
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || null;
// Each item can fan out to several provider calls (title variants, then a
// cover fallback), so 4 workers at 120ms was bursting hard enough to trip
// Google's per-second limit. Slower here costs a couple of minutes on a
// one-off backfill and avoids losing lookups to throttling.
const CONCURRENCY = 3;
const PAUSE_MS = 250;

const states = RETRY ? ['pending', 'notfound', 'error'] : ['pending'];

// --retry also revisits items that resolved to an ISBN but never got a cover,
// which is the most common partial result.
const coverGap = RETRY
  ? `OR (enrich_state = 'ok' AND (cover_url IS NULL OR cover_url = ''))`
  : '';

const pending = db
  .prepare(
    `SELECT id, title, creator, isbn, kind FROM items
     WHERE (enrich_state IN (${states.map(() => '?').join(',')}) ${coverGap})
       AND kind IN ('book', 'curriculum')
     ORDER BY id
     ${LIMIT ? 'LIMIT ' + LIMIT : ''}`
  )
  .all(...states);

if (!pending.length) {
  console.log('Nothing to enrich. (Use --retry to re-attempt failures.)');
  process.exit(0);
}

const applyMeta = db.prepare(
  `UPDATE items SET
     isbn        = COALESCE(?, isbn),
     isbn10      = COALESCE(?, isbn10),
     cover_url   = COALESCE(?, cover_url),
     publisher   = COALESCE(publisher, ?),
     published   = COALESCE(published, ?),
     page_count  = COALESCE(page_count, ?),
     enrich_state = ?,
     updated_at  = datetime('now')
   WHERE id = ?`
);

const markState = db.prepare(
  `UPDATE items SET enrich_state = ?, updated_at = datetime('now') WHERE id = ?`
);

let done = 0;
let found = 0;
let missing = 0;
let failed = 0;

function progress(label) {
  const pct = Math.round((done / pending.length) * 100);
  process.stdout.write(
    `\r[${String(pct).padStart(3)}%] ${done}/${pending.length}  ` +
      `found:${found} none:${missing} err:${failed}  ${label.slice(0, 40).padEnd(40)}`
  );
}

async function processOne(item) {
  try {
    const meta = item.isbn
      ? await lookupByIsbn(item.isbn)
      : await lookupByTitle(item.title, item.creator);

    if (!meta || (!meta.isbn && !meta.cover_url)) {
      markState.run('notfound', item.id);
      missing++;
      return;
    }

    // Open Library returns a blank placeholder image instead of a 404, so
    // verify before storing a URL the UI would render as an empty box.
    let cover = meta.cover_url;
    if (cover && !(await coverExists(cover))) cover = null;

    // Open Library's cover coverage is thinner than its bibliographic data.
    // When we have an ISBN but no usable art, ask Google Books for the
    // thumbnail — that recovers most of the gap.
    const isbn = meta.isbn || item.isbn;
    if (!cover && isbn) {
      const gb = await googleByIsbn(isbn);
      if (gb?.cover_url && (await coverExists(gb.cover_url))) {
        cover = gb.cover_url;
      } else {
        const direct = coverFromIsbn(isbn);
        if (direct && (await coverExists(direct))) cover = direct;
      }
    }

    applyMeta.run(
      meta.isbn || null,
      meta.isbn10 || null,
      cover,
      meta.publisher || null,
      meta.published || null,
      meta.page_count || null,
      cover || meta.isbn ? 'ok' : 'notfound',
      item.id
    );

    if (cover || meta.isbn) found++;
    else missing++;
  } catch (err) {
    markState.run('error', item.id);
    failed++;
  } finally {
    done++;
    progress(item.title);
  }
}

async function main() {
  console.log(
    `Enriching ${pending.length} item(s) via Open Library + Google Books...\n`
  );

  const queue = [...pending];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await processOne(item);
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  });

  await Promise.all(workers);

  const covers = db
    .prepare("SELECT COUNT(*) AS n FROM items WHERE cover_url IS NOT NULL AND cover_url <> ''")
    .get().n;
  const isbns = db
    .prepare("SELECT COUNT(*) AS n FROM items WHERE isbn IS NOT NULL AND isbn <> ''")
    .get().n;
  const total = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;

  console.log(`\n\nDone.`);
  console.log(`  covers: ${covers}/${total}`);
  console.log(`  ISBNs:  ${isbns}/${total}`);

  const issues = getProviderIssues();
  if (issues.length) {
    console.log(`\n  A provider throttled this run, so results are incomplete:`);
    for (const issue of issues) console.log(`    ${issue}`);
  }

  if (missing || failed) {
    console.log(`\n  ${missing + failed} unresolved — retry with: npm run enrich -- --retry`);
  }

  // One batched push rather than ~900 individual API calls — the outbox has
  // been collecting every row this run touched.
  if (sheets.isConfigured() && outboxSize()) {
    process.stdout.write(`\n  Pushing ${outboxSize()} change(s) to the Google Sheet... `);
    try {
      const r = await sheets.flushOutbox();
      console.log(`done (${r.updated} updated, ${r.appended} added).`);
    } catch (err) {
      console.log(`deferred.\n    ${err.message}`);
      console.log('    They stay queued and will go out on the next sync.');
    }
  }
  console.log('');
}

main();
