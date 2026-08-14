/**
 * Add a click-through BoardGameGeek search link beside every board game in the
 * Sheet, so filling in cover art is: click, copy image address, paste.
 *
 *   npm run game:links
 *
 * BGG sits behind Cloudflare bot protection, so covers can't be fetched
 * automatically — but a person browsing the site normally is exactly what it's
 * built for. This just removes the tedious part: finding each game.
 *
 * The links go in column Z. Sync only reads and writes columns A-Y, so this
 * column is invisible to the app and is never overwritten. Delete it whenever
 * you're done.
 */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../server/db.js';
import { isConfigured, configProblem, sheetUrl } from '../server/sheets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

const HELPER_COL = 'Z';
const TAB = 'Board Games';

if (!isConfigured()) {
  console.error(`\n  ${configProblem()}\n`);
  process.exit(1);
}

function keyFile() {
  const explicit = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(ROOT, explicit);
  return path.join(
    ROOT,
    fs.readdirSync(ROOT).find((f) => {
      if (!f.endsWith('.json') || f.startsWith('package')) return false;
      try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).type === 'service_account';
      } catch {
        return false;
      }
    })
  );
}

const creds = JSON.parse(fs.readFileSync(keyFile(), 'utf8'));
const jwt = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const { token } = await jwt.getAccessToken();
const SID = process.env.GOOGLE_SHEET_ID;
const API = `https://sheets.googleapis.com/v4/spreadsheets/${SID}`;

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Read the tab so links line up with the rows actually present, in their
// current order — the Sheet may have been sorted by hand.
const range = `'${TAB}'!A1:B`;
const grid = (await call('GET', `${API}/values/${encodeURIComponent(range)}`)).values || [];
if (grid.length < 2) {
  console.error(`\n  The "${TAB}" tab has no rows yet. Run: npm run sheet:init\n`);
  process.exit(1);
}

const withCover = new Set(
  db
    .prepare("SELECT id FROM items WHERE kind='boardgame' AND cover_url IS NOT NULL AND cover_url <> ''")
    .all()
    .map((r) => r.id)
);

const rows = [['find cover']];
let needing = 0;

for (let r = 1; r < grid.length; r++) {
  const id = Number(grid[r][0]);
  const title = grid[r][1];
  if (!title) {
    rows.push(['']);
    continue;
  }
  if (withCover.has(id)) {
    rows.push(['done']); // already has art — nothing to look up
    continue;
  }
  needing++;
  const q = encodeURIComponent(title);
  const url = `https://boardgamegeek.com/geeksearch.php?action=search&objecttype=boardgame&q=${q}`;
  // HYPERLINK renders as a normal clickable cell.
  rows.push([`=HYPERLINK("${url}","search BGG")`]);
}

await call('POST', `${API}/values:batchUpdate`, {
  // USER_ENTERED so the formula is evaluated rather than stored as text.
  valueInputOption: 'USER_ENTERED',
  data: [{ range: `'${TAB}'!${HELPER_COL}1:${HELPER_COL}${rows.length}`, values: rows }],
});

console.log(`\n  Added ${needing} lookup link(s) in column ${HELPER_COL} of "${TAB}".`);
console.log(`  ${sheetUrl()}\n`);
console.log('  For each game: click the link, open the game on BGG, right-click');
console.log('  the box image, "Copy Image Address", and paste it into that row\'s');
console.log('  cover_url cell. The app picks it up on the next sync.\n');
console.log(`  Column ${HELPER_COL} is outside the synced range (A-Y), so it is never`);
console.log('  overwritten. Delete it when you are finished.\n');
