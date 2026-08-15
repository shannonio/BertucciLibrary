/**
 * Fill in box art, designers, and play details for board games from BGG.
 *
 *   npm run games              # games missing a cover
 *   npm run games -- --retry   # re-attempt previous failures
 *   npm run games -- --limit 10
 *
 * Only fills fields that are empty — your CSV's player counts and age ratings
 * win over BGG's, because they describe the copy you actually own.
 */
import 'dotenv/config';
import { db, outboxSize } from '../server/db.js';
import * as bgg from '../server/bgg.js';
import * as sheets from '../server/sheets.js';
import { cacheCover } from '../server/covers.js';

const args = process.argv.slice(2);
const RETRY = args.includes('--retry');
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || null;

if (!bgg.isConfigured()) {
  console.error(`\n  ${bgg.configProblem()}\n`);
  process.exit(1);
}

const where = RETRY
  ? "kind = 'boardgame'"
  : "kind = 'boardgame' AND (cover_url IS NULL OR cover_url = '')";

const games = db
  .prepare(`SELECT * FROM items WHERE ${where} ORDER BY id ${LIMIT ? 'LIMIT ' + LIMIT : ''}`)
  .all();

if (!games.length) {
  console.log('\n  Every game already has cover art.\n');
  process.exit(0);
}

console.log(`\n  Looking up ${games.length} game(s) on BoardGameGeek...\n`);

const update = db.prepare(
  `UPDATE items SET
     cover_url = COALESCE(?, cover_url),
     creator   = COALESCE(creator, ?),
     publisher = COALESCE(publisher, ?),
     published = COALESCE(published, ?),
     players   = COALESCE(players, ?),
     play_time = COALESCE(play_time, ?),
     age_range = COALESCE(age_range, ?),
     summary   = COALESCE(summary, ?),
     updated_at = datetime('now')
   WHERE id = ?`
);

let found = 0;
let missed = 0;
const misses = [];

for (const [i, game] of games.entries()) {
  process.stdout.write(
    `\r  [${String(Math.round(((i + 1) / games.length) * 100)).padStart(3)}%] ` +
      `${i + 1}/${games.length}  found:${found} none:${missed}  ${game.title.slice(0, 32).padEnd(32)}`
  );

  try {
    const hits = await bgg.search(game.title, { limit: 3 });
    // Prefer an exact title match; BGG search is fuzzy and the top hit can be
    // an expansion or a similarly-named game.
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const best =
      hits.find((h) => norm(h.name) === norm(game.title)) ||
      hits.find((h) => norm(h.name).includes(norm(game.title))) ||
      hits[0];
    if (!best) { missed++; misses.push(game.title); continue; }

    const d = await bgg.thing(best.id);
    if (!d?.image) { missed++; misses.push(game.title); continue; }

    update.run(
      d.image,
      d.designers?.length ? d.designers.join(', ') : null,
      d.publisher,
      d.published,
      d.players,
      d.play_time,
      d.age,
      d.summary,
      game.id
    );
    await cacheCover(d.image);
    found++;
  } catch (err) {
    missed++;
    misses.push(`${game.title} (${err.message.slice(0, 40)})`);
  }

  await new Promise((r) => setTimeout(r, 700)); // be gentle with BGG
}

console.log(`\n\n  Done — ${found} matched, ${missed} not found.`);

if (misses.length) {
  console.log(`\n  No match for:`);
  for (const m of misses.slice(0, 12)) console.log(`    ${m}`);
  if (misses.length > 12) console.log(`    ...and ${misses.length - 12} more`);
  console.log('\n  Add covers for those by hand: open the item and tap "Find a cover".');
}

if (sheets.isConfigured() && outboxSize()) {
  process.stdout.write(`\n  Pushing ${outboxSize()} change(s) to the Sheet... `);
  try {
    const r = await sheets.flushOutbox();
    console.log(`done (${r.updated} updated).`);
  } catch (err) {
    console.log(`deferred: ${err.message}`);
  }
}
console.log('');
