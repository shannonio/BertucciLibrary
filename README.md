# Bertucci Library

A phone-friendly catalog of the home library and homeschool supplies. Browse by
cover, search everything, ask Claude what to build a lesson from, and add new
things by ISBN or by photographing a shelf.

---

## Running it

```bash
npm install          # once
npm start
```

The server prints two addresses:

```
On this Mac:   http://localhost:4173
On your phone: http://192.168.x.x:4173
```

Open the phone address while on the same WiFi. In Safari, tap **Share → Add to
Home Screen** to install it as an app — it opens full-screen with its own icon.

The Mac has to be awake and running `npm start` for the phone to reach it.

## Turning on the Claude features

The **Ask** tab and **photo scanning** need an Anthropic API key. Everything
else — browsing, search, covers, adding by ISBN, adding manually — works
without one.

1. Get a key at <https://console.anthropic.com/settings/keys>
2. Put it in `.env` next to `package.json`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Restart the server.

The Ask tab shows a setup reminder until the key is present, so you'll know at a
glance whether it's configured.

---

## What each tab does

**Library** — every item as a cover. Search runs over titles, authors, genres,
subjects, summaries, tags, and notes, and updates as you type. Tap any cover for
the full record, including ISBN. Once you have more than one type of item, filter
chips appear at the top.

**Ask** — plain-language questions about the collection. Claude *searches the
actual catalog* before answering rather than guessing from memory, so
"what do we have on insects for a six-year-old" returns books you own. It's built
for lesson planning: ask it to build a unit and it groups real items into a
sequence and tells you where the collection has a gap.

**Add** — three ways in:

- *Photo* — snap a shelf or a stack of covers. Claude reads the titles, each one
  is looked up automatically, and you get a review list showing which matched,
  which are low-confidence, and which you already own. Nothing is saved until
  you tap Add.
- *ISBN* — type the number under the barcode; confirm the match; save. This is
  the only path that guarantees the **exact edition** you own.
- *Manual* — for board games, craft supplies, and anything without a barcode.

---

---

## The Google Sheet

The Sheet is the **source of truth**. `data/library.db` is a derived copy that
keeps search, covers, and the Ask tab fast — you can delete it and rebuild the
whole catalog with `npm run sheet:pull`.

- **You edit the Sheet** → the app pulls those changes when you open it, or when
  you tap the sync arrow next to the item count.
- **You add in the app** (ISBN, photo scan, manual) → the row appears in the
  Sheet within a couple of seconds.

Bulk editing is what the Sheet is for: fixing titles, filling in `location` and
`age_range` down a column, tagging a whole genre at once.

### Working in it

- **Don't touch the `id` column.** It's how rows are matched. Leave it blank on
  a new row and the app fills in the id — plus the other defaults — on the next
  pull.
- **`created_at` and `updated_at` are managed for you.** They're shown for
  information; editing them has no effect, since the database owns those.
- **You can sort, filter, and reorder columns freely.** Rows are matched by id
  and columns by their header name, not by position.
- **Deleting a row deletes the item.** Blanking the title also removes it.
- Columns are ordered for editing: identity, then the fields worth changing,
  then long `summary` text, then machine-managed columns (`source`,
  `enrich_state`, `created_at`, `updated_at`) out on the right. Leave those last
  four alone unless you know what you're doing — blanking `enrich_state` makes
  the enrichment script re-attempt that item, which is occasionally useful.

### Syncing

| When | What happens |
|---|---|
| Server start | Pushes anything queued, then pulls the Sheet |
| App open | Pulls in the background, after your library is already on screen |
| Sync arrow in the header | Pushes then pulls, on demand |
| Any add/edit/delete in the app | Pushes that row within a second |
| `npm run enrich` / `npm run import` | One batched push at the end |

`npm run sheet:pull` does the same from the command line.

### Conflicts

**The Sheet wins.** On pull, its values overwrite the local copy for every
column it provides. Because the app pushes immediately after every change, the
window where the local copy is ahead is only a second or two.

The one case to watch: editing a row in the Sheet while `npm run enrich` is
running on that same row. Whichever lands last wins; re-run enrich if a cover
goes missing.

### If Google is unreachable

Nothing breaks. The app keeps running on the local catalog, and any changes you
make queue up in an outbox table and go out on the next successful sync. A
failed sync shows the sync arrow in red with the reason.

### Safety net

A pull refuses to delete items if the Sheet is missing more than 10% of them
(minimum 25). A cleared sheet or a half-finished API read looks identical to
"deleted 900 books", and only one of those should be able to wipe your catalog.
If you really did delete a lot on purpose:

```bash
npm run sheet:pull -- --force
```

### Setup

1. Cloud Console → your project → enable the **Google Sheets API**
2. Create a service account, download a JSON key into the project folder
3. Create a Sheet; put its id (the long string in the URL between `/d/` and
   `/edit`) in `.env` as `GOOGLE_SHEET_ID`
4. **Share the Sheet with the service account's email address as an Editor.**
   This is the step people miss — without it every call fails with a 403.
5. `npm run sheet:init` — writes the header row and all your items into it

The service-account key is in `.gitignore`. If it ever leaks, delete that key in
Cloud Console and create a new one; a service account can only reach what you've
explicitly shared with it.

---

## Adding things beyond books

The catalog was built generic from the start. Every item has a **kind**:

| Kind | Use it for |
|---|---|
| `book` | Books |
| `boardgame` | Board and card games |
| `curriculum` | Teaching guides, printed or digital courses |
| `material` | Craft supplies, manipulatives, science kits |
| `media` | DVDs, audio, anything else |

Pick the kind in the **Add → Add manually** form. Board games get `players` and
`play_minutes` fields; anything can carry `age_range`, `location`, `tags`, and
`notes`. Search and the Ask tab pick up new kinds automatically — no code
changes needed.

### Digital curriculum

There's a `file_path` column ready for pointing an item at a PDF on disk. The
MVP doesn't upload or serve those files yet — see *Not built yet* below.

---

## Re-importing the CSV

```bash
npm run import                    # book_catalog.csv
npm run import -- some-other.csv
```

Safe to re-run. Matching is on title + author, so a corrected CSV updates the
existing rows instead of creating duplicates, and previously-fetched covers and
ISBNs are preserved.

## Filling in covers and ISBNs

```bash
npm run enrich              # anything not yet attempted
npm run enrich -- --retry   # also re-try failures and items still missing a cover
npm run enrich -- --limit 50
```

Looks each item up in Open Library, falling back to Google Books, and stores the
ISBN and cover art. It's resumable — Ctrl-C and re-run whenever.

**Current state: 874 of 968 ISBNs, 862 covers** — about 89%. Repeated runs have
converged; the last pass gained only 4 covers, so this is effectively the floor
for automatic matching.

The remaining ~106 without cover art are genuinely not in either database, and
they cluster in predictable places:

| Count | Kind of thing |
|---|---|
| 19 | Early reader / phonics curriculum |
| 5 | Math curriculum comics |
| 5 | Coloring books |
| 5 | Laminated reference charts |
| 4 | Activity books |
| rest | Workbooks, manga volumes, treasuries, one-off imports |

Small-press homeschool material, consumables, and laminated charts mostly don't
carry catalogued ISBNs at all. Those items still search and display fine — they
show a typeset title card instead of cover art. To fix one by hand, find its
ISBN and re-add it through **Add → ISBN**.

### If a run reports throttling

Both providers rate-limit bursts. Lookups retry with backoff automatically, so
you'll usually see the harmless form:

```
Google Books: Throttled briefly; the request succeeded after a retry.
```

That's informational — nothing was lost. If it instead says throttling persisted
*after retries*, you may have hit Google's 1,000/day project quota; it resets at
midnight Pacific, and re-running the next day picks up where it left off.

### A note on which edition you get

When a book is matched by **title** — the CSV import, the enrichment script, or
a photo scan — Open Library returns a *work*, which bundles every edition ever
printed. The cover art is the work's representative cover, so it looks right.
The ISBN, though, is whichever edition happens to come back first, and that can
be a foreign-language or reprint edition of the correct book.

In practice this doesn't matter for finding things on a shelf. If you need the
ISBN to match the physical copy exactly — for resale, insurance, or a library
export — add that book through **Add → ISBN** with the barcode instead.

---

## Where things live

```
book_catalog.csv       your original export — never modified
data/library.db        the catalog (SQLite). This is the file to back up.
server/
  index.js             HTTP routes
  db.js                schema, full-text search
  lookup.js            Open Library + Google Books
  claude.js            the assistant and photo scanning
public/                the phone app
scripts/
  import-csv.js
  enrich.js
```

### Backing up

`data/library.db` is the whole catalog in one file. Copy it somewhere safe:

```bash
cp data/library.db ~/Dropbox/library-$(date +%Y%m%d).db
```

---

## Not built yet

Deliberately left out of this first version:

- **Digital curriculum upload.** The `file_path` column exists but there's no
  upload or in-app reader. Needs a decision about where PDFs live.
- **Barcode scanning by camera.** ISBNs are typed today. A live barcode scanner
  is worth adding if you're cataloguing in bulk.
- **Editing an item after it's saved.** You can add and remove; changing a title
  or adding a location means removing and re-adding. The API supports `PATCH`,
  so this is a UI-only gap.
- **Loans / who-has-what.**
- **Multi-user access from outside the house.** It's LAN-only by design, and has
  no login — anyone on your WiFi can reach it. Don't expose the port to the
  internet as-is.
