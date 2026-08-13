import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'library.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// The catalog is deliberately generic: books, board games, curriculum, and
// craft supplies all live in `items` and differ only by `kind`. Fields that
// only apply to some kinds (isbn, players, age_range) are nullable.
db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'book',
  title        TEXT NOT NULL,
  creator      TEXT,              -- author / publisher / designer
  genre        TEXT,
  subject      TEXT,              -- comma-separated topics
  summary      TEXT,
  isbn         TEXT,              -- ISBN-13 preferred
  isbn10       TEXT,
  cover_url    TEXT,
  publisher    TEXT,
  published    TEXT,
  page_count   INTEGER,
  age_range    TEXT,              -- "6-9", "K-2", etc.
  players      TEXT,              -- board games: "2-4"
  play_minutes INTEGER,
  location     TEXT,              -- which shelf/bin it lives on
  notes        TEXT,
  tags         TEXT,              -- comma-separated, user-defined
  quantity     INTEGER NOT NULL DEFAULT 1,
  file_path    TEXT,              -- digital curriculum: path to the PDF etc.
  source       TEXT,              -- 'csv' | 'isbn' | 'photo' | 'manual'
  enrich_state TEXT NOT NULL DEFAULT 'pending', -- pending | ok | notfound | error
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_kind    ON items(kind);
CREATE INDEX IF NOT EXISTS idx_items_isbn    ON items(isbn);
CREATE INDEX IF NOT EXISTS idx_items_enrich  ON items(enrich_state);
CREATE INDEX IF NOT EXISTS idx_items_title   ON items(title);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, creator, genre, subject, summary, tags, notes,
  content='items',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, creator, genre, subject, summary, tags, notes)
  VALUES (new.id, new.title, new.creator, new.genre, new.subject, new.summary, new.tags, new.notes);
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, creator, genre, subject, summary, tags, notes)
  VALUES ('delete', old.id, old.title, old.creator, old.genre, old.subject, old.summary, old.tags, old.notes);
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, creator, genre, subject, summary, tags, notes)
  VALUES ('delete', old.id, old.title, old.creator, old.genre, old.subject, old.summary, old.tags, old.notes);
  INSERT INTO items_fts(rowid, title, creator, genre, subject, summary, tags, notes)
  VALUES (new.id, new.title, new.creator, new.genre, new.subject, new.summary, new.tags, new.notes);
END;

-- ---------------------------------------------------------------- Sheet sync
--
-- Writes reach the items table from three places: the HTTP routes (via the
-- helpers below), the enrichment script, and the CSV importer — the latter two
-- using their own prepared statements. Capturing changes with triggers rather
-- than by wrapping the helpers means every path is covered, including any
-- added later.
--
-- The outbox is durable, so a Sheets outage just queues work instead of failing
-- a user's write.

CREATE TABLE IF NOT EXISTS sheet_outbox (
  item_id   INTEGER PRIMARY KEY,
  op        TEXT NOT NULL,          -- 'upsert' | 'delete'
  queued_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO sync_state(key, value) VALUES ('suppress_outbox', '0');
INSERT OR IGNORE INTO sync_state(key, value) VALUES ('last_pull_at', '');

-- Each trigger is gated on the suppression flag so that a pull, which writes
-- rows that came *from* the Sheet, doesn't immediately queue them to be pushed
-- straight back.
CREATE TRIGGER IF NOT EXISTS items_sheet_ai AFTER INSERT ON items
WHEN (SELECT value FROM sync_state WHERE key = 'suppress_outbox') = '0'
BEGIN
  INSERT INTO sheet_outbox(item_id, op, queued_at)
  VALUES (new.id, 'upsert', datetime('now'))
  ON CONFLICT(item_id) DO UPDATE SET op = 'upsert', queued_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS items_sheet_au AFTER UPDATE ON items
WHEN (SELECT value FROM sync_state WHERE key = 'suppress_outbox') = '0'
BEGIN
  INSERT INTO sheet_outbox(item_id, op, queued_at)
  VALUES (new.id, 'upsert', datetime('now'))
  ON CONFLICT(item_id) DO UPDATE SET op = 'upsert', queued_at = datetime('now');
END;

CREATE TRIGGER IF NOT EXISTS items_sheet_ad AFTER DELETE ON items
WHEN (SELECT value FROM sync_state WHERE key = 'suppress_outbox') = '0'
BEGIN
  INSERT INTO sheet_outbox(item_id, op, queued_at)
  VALUES (old.id, 'delete', datetime('now'))
  ON CONFLICT(item_id) DO UPDATE SET op = 'delete', queued_at = datetime('now');
END;
`);

export const ITEM_KINDS = [
  'book',
  'boardgame',
  'curriculum',
  'material',
  'media',
];

/**
 * FTS5 treats a lot of punctuation as syntax. Users type things like
 * "bugs & insects" or "what's this?" — quote each bare word so the query is
 * always a valid MATCH expression, and prefix-match the final token so
 * search-as-you-type feels responsive.
 */
export function ftsQuery(raw, join = 'AND') {
  const tokens = String(raw || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
  if (!tokens.length) return null;
  return tokens
    .map((t, i) => {
      const quoted = `"${t.replace(/"/g, '""')}"`;
      return i === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(` ${join} `);
}

const COLUMNS = [
  'id', 'kind', 'title', 'creator', 'genre', 'subject', 'summary', 'isbn',
  'isbn10', 'cover_url', 'publisher', 'published', 'page_count', 'age_range',
  'players', 'play_minutes', 'location', 'notes', 'tags', 'quantity',
  'file_path', 'source', 'enrich_state', 'created_at', 'updated_at',
];

// Qualified with the `i` alias because the FTS join puts identically-named
// columns (title, creator, ...) in scope from both tables.
const SELECT_COLS = COLUMNS.map((c) => `i.${c}`).join(', ');
const SELECT_COLS_PLAIN = COLUMNS.join(', ');

/**
 * Shared search used by both the HTTP API and Claude's search tool, so the
 * assistant can only ever see rows the UI could also show.
 */
export function searchItems(opts = {}) {
  const res = runSearch(opts, 'AND');
  // A phrase like "picture books about weather" ANDs to nothing even though
  // several rows are clearly relevant. Widen to OR rather than showing an
  // empty shelf.
  if (res.total === 0 && opts.q && /\s/.test(String(opts.q).trim())) {
    return runSearch(opts, 'OR');
  }
  return res;
}

function runSearch({ q, kind, genre, subject, limit = 40, offset = 0 } = {}, join = 'AND') {
  const where = [];
  const params = {};

  const match = q ? ftsQuery(q, join) : null;
  let from = 'items i';
  let order = 'i.title COLLATE NOCASE ASC';

  if (match) {
    from = 'items_fts JOIN items i ON i.id = items_fts.rowid';
    where.push('items_fts MATCH @match');
    params.match = match;
    // Weights follow the fts5 column order (title, creator, genre, subject,
    // summary, tags, notes). bm25 is negative-better, so plain ASC is right.
    order = 'bm25(items_fts, 10.0, 6.0, 2.0, 4.0, 1.0, 3.0, 1.0)';
  }
  if (kind) {
    where.push('i.kind = @kind');
    params.kind = kind;
  }
  if (genre) {
    where.push('i.genre LIKE @genre');
    params.genre = `%${genre}%`;
  }
  if (subject) {
    where.push('i.subject LIKE @subject');
    params.subject = `%${subject}%`;
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.limit = Math.min(Number(limit) || 40, 200);
  params.offset = Math.max(Number(offset) || 0, 0);

  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM ${from} ${clause}
       ORDER BY ${order} LIMIT @limit OFFSET @offset`
    )
    .all(params);

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM ${from} ${clause}`)
    .get(params);

  return { rows, total };
}

export function getItem(id) {
  return db.prepare(`SELECT ${SELECT_COLS_PLAIN} FROM items WHERE id = ?`).get(id);
}

// Columns declared NOT NULL in the schema, with the value to use when a caller
// (usually a blank cell in the Sheet) supplies nothing.
export const NOT_NULL_DEFAULTS = {
  kind: 'book',
  quantity: 1,
  source: 'manual',
  enrich_state: 'pending',
};

const INSERT_FIELDS = [
  'kind', 'title', 'creator', 'genre', 'subject', 'summary', 'isbn', 'isbn10',
  'cover_url', 'publisher', 'published', 'page_count', 'age_range', 'players',
  'play_minutes', 'location', 'notes', 'tags', 'quantity', 'file_path',
  'source', 'enrich_state',
];

export function insertItem(item) {
  const row = {};
  for (const f of INSERT_FIELDS) row[f] = item[f] ?? null;
  row.kind = row.kind || 'book';
  row.quantity = row.quantity ?? 1;
  row.source = row.source || 'manual';
  row.enrich_state = row.enrich_state || 'pending';

  const cols = INSERT_FIELDS.join(', ');
  const vals = INSERT_FIELDS.map((f) => `@${f}`).join(', ');
  const info = db
    .prepare(`INSERT INTO items (${cols}) VALUES (${vals})`)
    .run(row);
  return getItem(info.lastInsertRowid);
}

export function updateItem(id, patch) {
  const allowed = INSERT_FIELDS.filter((f) => f in patch);
  if (!allowed.length) return getItem(id);
  const set = allowed.map((f) => `${f} = @${f}`).join(', ');
  const params = { id };
  for (const f of allowed) params[f] = patch[f];
  db.prepare(
    `UPDATE items SET ${set}, updated_at = datetime('now') WHERE id = @id`
  ).run(params);
  return getItem(id);
}

export function deleteItem(id) {
  return db.prepare('DELETE FROM items WHERE id = ?').run(id).changes > 0;
}

// ---------------------------------------------------------------- Sheet sync

export function getSyncState(key) {
  return db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value ?? null;
}

export function setSyncState(key, value) {
  db.prepare(
    `INSERT INTO sync_state(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

/**
 * Run `fn` with the outbox triggers disabled — used while applying rows that
 * came from the Sheet, so they aren't queued straight back to it. Restores the
 * flag even if `fn` throws, so a failed pull can't wedge syncing off.
 */
export function withOutboxSuppressed(fn) {
  setSyncState('suppress_outbox', '1');
  try {
    return fn();
  } finally {
    setSyncState('suppress_outbox', '0');
  }
}

export function readOutbox(limit = 5000) {
  return db
    .prepare('SELECT item_id, op FROM sheet_outbox ORDER BY queued_at, item_id LIMIT ?')
    .all(limit);
}

export function clearOutbox(itemIds) {
  if (!itemIds?.length) return 0;
  const stmt = db.prepare('DELETE FROM sheet_outbox WHERE item_id = ?');
  const run = db.transaction((ids) => {
    let n = 0;
    for (const id of ids) n += stmt.run(id).changes;
    return n;
  });
  return run(itemIds);
}

export function outboxSize() {
  return db.prepare('SELECT COUNT(*) AS n FROM sheet_outbox').get().n;
}

/** Queue every current item for a push — used by the one-time sheet bootstrap. */
export function queueAllForPush() {
  db.prepare(
    `INSERT INTO sheet_outbox(item_id, op, queued_at)
     SELECT id, 'upsert', datetime('now') FROM items
     WHERE true
     ON CONFLICT(item_id) DO UPDATE SET op = 'upsert'`
  ).run();
  return outboxSize();
}

/**
 * Insert or update a row at an explicit id. Needed because the Sheet is the
 * source of truth: deleting data/library.db and pulling must reconstruct the
 * catalog with its original ids intact, so links and outbox entries still line
 * up. Only touches the fields provided, leaving anything absent from the Sheet
 * alone.
 */
export function upsertItemWithId(id, fields) {
  const existing = getItem(id);
  const provided = INSERT_FIELDS.filter((f) => f in fields);

  if (existing) {
    if (!provided.length) return existing;
    const set = provided.map((f) => `${f} = @${f}`).join(', ');
    const params = { id };
    for (const f of provided) params[f] = fields[f];
    // A blank cell in the Sheet parses to null, which would violate the NOT
    // NULL columns. Fall back to the existing value, then the column default —
    // clearing the `quantity` cell shouldn't be able to break every later sync.
    for (const [f, fallback] of Object.entries(NOT_NULL_DEFAULTS)) {
      if (f in params && (params[f] === null || params[f] === undefined)) {
        params[f] = existing[f] ?? fallback;
      }
    }
    db.prepare(
      `UPDATE items SET ${set}, updated_at = datetime('now') WHERE id = @id`
    ).run(params);
    return getItem(id);
  }

  const row = { id };
  for (const f of INSERT_FIELDS) row[f] = fields[f] ?? null;
  row.kind = row.kind || 'book';
  row.quantity = row.quantity ?? 1;
  row.source = row.source || 'sheet';
  row.enrich_state = row.enrich_state || 'pending';

  const cols = ['id', ...INSERT_FIELDS].join(', ');
  const vals = ['@id', ...INSERT_FIELDS.map((f) => `@${f}`)].join(', ');
  db.prepare(`INSERT INTO items (${cols}) VALUES (${vals})`).run(row);
  return getItem(id);
}

export function allItems() {
  return db
    .prepare(`SELECT ${SELECT_COLS_PLAIN} FROM items ORDER BY id`)
    .all();
}

export function allItemIds() {
  return db.prepare('SELECT id FROM items').all().map((r) => r.id);
}

export function stats() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  const byKind = db
    .prepare('SELECT kind, COUNT(*) AS n FROM items GROUP BY kind ORDER BY n DESC')
    .all();
  const withCovers = db
    .prepare("SELECT COUNT(*) AS n FROM items WHERE cover_url IS NOT NULL AND cover_url <> ''")
    .get().n;
  const withIsbn = db
    .prepare("SELECT COUNT(*) AS n FROM items WHERE isbn IS NOT NULL AND isbn <> ''")
    .get().n;
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM items WHERE enrich_state = 'pending'")
    .get().n;
  const topGenres = db
    .prepare(
      `SELECT genre, COUNT(*) AS n FROM items
       WHERE genre IS NOT NULL AND genre <> ''
       GROUP BY genre ORDER BY n DESC LIMIT 25`
    )
    .all();
  return { total, byKind, withCovers, withIsbn, pending, topGenres };
}
