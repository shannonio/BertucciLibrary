/**
 * Download every cover image into data/covers/ so the app serves art from disk
 * instead of depending on someone else's server staying up.
 *
 *   npm run covers            # fetch anything not already cached
 *   npm run covers -- --retry # re-attempt ones that failed before
 *
 * Resumable and safe to re-run: images already held are skipped instantly.
 */
import 'dotenv/config';
import { db } from '../server/db.js';
import { cacheCover, localCoverFor, cacheStats } from '../server/covers.js';

const RETRY = process.argv.includes('--retry');
const CONCURRENCY = 4;

const rows = db
  .prepare(
    `SELECT id, title, cover_url FROM items
     WHERE cover_url IS NOT NULL AND cover_url <> ''
       AND cover_url NOT LIKE '/covers/%'
     ORDER BY id`
  )
  .all();

const todo = RETRY ? rows : rows.filter((r) => !localCoverFor(r.cover_url));

if (!todo.length) {
  const s = cacheStats();
  console.log(`\n  Everything is already cached — ${s.files} images, ${s.mb} MB.\n`);
  process.exit(0);
}

console.log(`\n  Caching ${todo.length} cover image(s)...\n`);

let done = 0;
let saved = 0;
let already = 0;
let failed = 0;
const failures = [];

function progress(label) {
  const pct = Math.round((done / todo.length) * 100);
  process.stdout.write(
    `\r  [${String(pct).padStart(3)}%] ${done}/${todo.length}  ` +
      `saved:${saved} had:${already} failed:${failed}  ${label.slice(0, 34).padEnd(34)}`
  );
}

const queue = [...todo];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const r = await cacheCover(item.cover_url);
      if (r.cached) saved++;
      else if (r.skipped) already++;
      else {
        failed++;
        failures.push({ title: item.title, error: r.error });
      }
      done++;
      progress(item.title);
      await new Promise((res) => setTimeout(res, 60));
    }
  })
);

const s = cacheStats();
console.log(`\n\n  Done — ${saved} newly cached, ${already} already held, ${failed} failed.`);
console.log(`  Cache now holds ${s.files} images (${s.mb} MB) in data/covers/\n`);

if (failures.length) {
  console.log(`  Could not fetch ${failures.length}:`);
  for (const f of failures.slice(0, 10)) {
    console.log(`    ${f.title.slice(0, 42).padEnd(42)} ${f.error}`);
  }
  if (failures.length > 10) console.log(`    ...and ${failures.length - 10} more`);
  console.log(`\n  Those still load from their original URL, so nothing is broken.\n`);
}
