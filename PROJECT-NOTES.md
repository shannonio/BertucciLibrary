# Project notes — state, decisions, and dead ends

Companion to `README.md`. The README says **how to use** the app; this says
**where things stand, why they're built the way they are, and what's already
been tried and ruled out.** Read this first when picking the project back up.

Last updated: 2026-08-15

---

## Where things stand

**3,959 items** in the catalog:

| Kind | Count | Source |
|---|---|---|
| `curriculum` | 2,876 | Google Drive index (local only — never synced to the Sheet) |
| `book` | 968 | `book_catalog.csv`, enriched with ISBNs and covers |
| `boardgame` | 115 | `game_catalog.csv` |

872 covers cached locally (38 MB in `data/covers/`), 874 ISBNs.

Configured and working: Claude (`claude-sonnet-5`), Google Sheet sync,
Google Books lookups, in-app cover search, Drive indexing.

### Open items

1. **BGG token** — applied for, awaiting approval. When it arrives:
   ```
   BGG_TOKEN=your-application-token     # in .env
   npm run games
   ```
   That fills box art for all 115 games plus designers, publisher, year, and
   descriptions. Verified against realistic BGG XML but never against the live
   API, so watch the first run.

2. **Move to the always-on Mac server** — see README → *Running it always-on,
   on the tailnet*, and the checklist below. Not done yet.

3. `GOOGLE_SEARCH_CX` is still in `.env` but **unused** — safe to delete
   (see *Dead ends* below).

---

## Picking this up on another computer

The repo alone is not enough to run — two files are gitignored and **cannot be
regenerated from anywhere**:

| File | What it is | If lost |
|---|---|---|
| `.env` | API keys, Sheet id, Drive folder id | Re-issue each key; see *The setup* below for which |
| `bertuccilibrary-*.json` | Google service-account key | Generate a new key in Cloud Console, re-share the Sheet and Drive folder with it |

Copy both by hand (AirDrop, a USB stick, or a password manager — not email, not
a git commit).

Then:

```bash
npm install          # MUST run here — better-sqlite3 is compiled per-machine
npm run sheet:pull   # rebuilds the catalog from the Sheet
npm run drive -- --folder … --exclude … --prune   # the full command below
npm run covers       # re-downloads the local cover cache
npm start
```

Copying `node_modules/` across machines will **not** work — `better-sqlite3` is
a native module built against the local architecture and Node version.

`npm run sheet:pull` restores books and games, but not curriculum (Drive is
their source of truth) and not covers (local cache). Those two commands take
roughly 25 and 15 minutes. **Copying `data/` across instead is much faster** and
gets you running immediately; the commands above are the fallback if you can't.

---

## The setup, concretely

Everything runs off one Google Cloud project, `bertuccilibrary`, and one
service account:

```
bertucci-library-service@bertuccilibrary.iam.gserviceaccount.com
```

Anything Google-related that fails with a 403 is almost always one of: the API
isn't enabled on the project, the resource isn't *shared* with that address, or
the API key's restrictions don't include the API being called. All three
produce similar-looking errors — see *Dead ends*.

| Resource | ID / location |
|---|---|
| Google Sheet | `1eWYb6nQNeng0xW0OnX792IOdqLXqfRb7-WTjHelbPAE` |
| Drive folder | `1xkHLGbJ2BlvMAHhBDiA2Qqxn5JqLizMQ` ("Homeschool") |
| Service-account key | `bertuccilibrary-*.json` in the repo root (gitignored) |
| Secrets | `.env` (gitignored) |

### The Drive index command

Re-running the plain command **will re-add everything that was deliberately
excluded.** Always use this one:

```bash
npm run drive -- \
  --folder 1xkHLGbJ2BlvMAHhBDiA2Qqxn5JqLizMQ \
  --exclude "monthly progress,monthly reports,schedule and supply,master list" \
  --exclude-ext "css,js,html" \
  --prune
```

`--prune` is what makes a *newly added* exclusion take effect on files already
indexed. Without it, tightening a filter leaves the old rows behind.

---

## Decisions worth not re-litigating

**The Sheet is the source of truth; SQLite is a derived cache.** Sheets is far
too slow to query per keystroke and has no full-text search, so the app reads
SQLite and syncs. Deleting `data/library.db` and running `npm run sheet:pull`
rebuilds the catalog with ids intact — that's the intended recovery path.

**Sync uses an outbox table populated by SQLite triggers**, not by wrapping the
helper functions. Writes reach `items` from the HTTP routes, `enrich.js`, and
`import-csv.js` — the latter two with their own prepared statements. Triggers
catch every path, including any added later.

**Drive-indexed files never go to the Sheet.** Two reasons: 2,876 machine-
generated rows would swamp the hand-curated tabs and overflow the 1,000-row
default; and a pull treats "in the DB but not in the Sheet" as a deletion, so
every sync would have tried to delete all of them. Drive is their source of
truth. Enforced by `sheetSyncedItemIds()` in `server/db.js`.

**Cover images are cached to `data/covers/` and served locally.** ~2 ms from
disk versus ~330 ms from Open Library, and they survive a provider blocking
hotlinks or reorganising URLs. The catalog and Sheet still store the *original*
URL as the record of provenance; the swap to a local path happens on the way
out of the API.

**`play_time` is TEXT, not an integer.** Real game boxes say "20-30 min" and
"Varies". The original `play_minutes INTEGER` column was migrated away.

**Per-child records are deliberately excluded from the Drive index.** Progress
reports and the schedule spreadsheets that name the children. Text extraction
would have put their contents into the catalog, the Sheet, and Claude's
context. See the `--exclude` list above.

---

## Dead ends — already tried, don't repeat

**Google Images / Custom Search JSON API — permanently unavailable.** Google
closed it to new customers; a new project gets `403 "This project does not have
the access to Custom Search JSON API"` no matter how it's configured, and the
whole API retires 2027-01-01. Cost several rounds of setup before this was
found. The in-app cover picker uses Google Books + Open Library instead.

**Programmable Search Engine "search the entire web" — gone.** Discontinued for
new signups Aug 2025; new engines cap at 50 domains. Moot now.

**Scraping BoardGameGeek's website — no.** The site sits behind Cloudflare bot
protection (`cf-mitigated: challenge`). Their **XML API** is the supported path
and just needs the registration token. Their image CDN
(`cf.geekdo-images.com`) is open with no referrer check, which is why pasting a
URL by hand works.

**Wikipedia / Wikidata for game covers — useless.** Wikipedia returns wrong
games ("Mycelia" → *Avatar: Fire and Ash*). Wikidata matches correctly but only
has Creative Commons *gameplay photos*, since box art is copyrighted.

**Full-text search *inside* curriculum files — mostly not there.** Only 4 files
are native Google Docs/Slides/Sheets, which are the only ones Drive can export
text from. The rest — 1,737 PDFs, 796 audio files, 125 images, 102 videos, 43
Excel — are indexed by **filename and folder path only**. In practice folder
names carry most of the meaning ("Math/Grade 3/Fractions"), so search works
well; just don't expect a phrase from inside a PDF to match. Real PDF text
extraction would need a parser library — not built.

---

## Traps that already bit, now guarded

Worth knowing about, because the guards are non-obvious:

- **Sheet column alignment.** Adding a column to `SHEET_COLUMNS` while the
  Sheet's header row was stale would write every value one column left, silently
  corrupting 1,000+ rows. `ensureHeader()` now verifies the *entire* header row
  before any positional write, not just that A1 says "id".
- **Stale JavaScript on phones.** `Cache-Control: no-cache` isn't enough —
  Chrome keeps ES modules in a per-document module map. Asset URLs are stamped
  with the file's mtime (`/app.js?v=…`).
- **`updated_at` in the Sheet.** Pulling it back caused every row to look
  changed on every sync, forever. It's in `READ_ONLY_ON_PULL`.
- **Blank cells in NOT NULL columns.** A hand-typed Sheet row with an empty
  `quantity` used to make every subsequent pull fail outright.
- **The delete guard.** A pull refuses to delete if the Sheet is missing >10% of
  items (min 25). A cleared sheet and a partial API read look identical to
  "deleted everything". `npm run sheet:pull -- --force` overrides.
- **`req.on('close')` on a POST** fires when the body is read, not when the
  client disconnects — it was aborting every Ask request instantly. The handler
  listens on `res`.
- **Lazy-loaded images.** Bit this project three separate times. Covers below
  the fold legitimately haven't loaded; treating that as failure replaced good
  covers with fallback cards. The stall sweep now exempts local `/covers/` paths.

---

## Layout

```
server/
  index.js       HTTP routes, static serving, cover cache endpoint
  db.js          schema, migrations, FTS search, sync outbox triggers
  sheets.js      Google Sheet pull/push, multi-tab routing
  drive.js       Drive walk + text extraction
  covers.js      local cover cache
  lookup.js      Open Library + Google Books (ISBN/cover)
  imagesearch.js in-app cover picker sources
  bgg.js         BoardGameGeek XML API (needs BGG_TOKEN)
  claude.js      Ask tab agent loop + photo scanning
scripts/
  import-csv.js  CSV → catalog (auto-detects books vs games)
  enrich.js      ISBN + cover lookup for books
  enrich-games.js BGG lookup for games
  index-drive.js Drive indexer
  cache-covers.js download covers locally
  sheet-init.js / sheet-pull.js
  game-cover-links.js  BGG search links in the Sheet (pre-token workaround)
  install-service.sh   launchd service for the always-on server
public/          the phone app (no build step)
data/            library.db, covers/, logs/  — all gitignored
```

**`data/` is rebuildable but slow** (~25 min Drive index, ~15 min covers). Worth
copying rather than regenerating when moving machines. `.env` and the
service-account key are **not** rebuildable — copy those first.

---

## Not built

- PDF text extraction
- Camera barcode scanning (ISBNs are typed)
- Editing an item in the app (add/remove only; the API supports `PATCH`, so
  it's a UI gap). Bulk editing is done in the Sheet.
- Loans / who-has-what
- Any authentication — deliberate; the tailnet is the security boundary
- Scheduled refreshes of the Drive index and covers
