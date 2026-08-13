/**
 * Google Sheet <-> SQLite sync.
 *
 * The Sheet is the source of truth for content; SQLite is a derived read-model
 * that keeps search, covers, and the Ask tab fast. Deleting data/library.db and
 * running a pull rebuilds the catalog from scratch, ids included.
 *
 *   pull()         Sheet -> DB. The Sheet wins on every column it provides.
 *   flushOutbox()  DB -> Sheet. Drains changes queued by the triggers in db.js.
 *
 * Every function here is a no-op when the Sheet isn't configured, so the app
 * runs on SQLite alone exactly as it did before.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JWT } from 'google-auth-library';

import {
  db, getItem, deleteItem, upsertItemWithId, allItems, allItemIds,
  readOutbox, clearOutbox, outboxSize, withOutboxSuppressed, setSyncState,
  NOT_NULL_DEFAULTS,
  getSyncState,
} from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(here, '..');
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * Column order in the Sheet, chosen for someone editing by hand: identity
 * first, then the fields worth bulk-editing, then long text, then
 * machine-managed columns pushed out to the right.
 */
export const SHEET_COLUMNS = [
  'id',
  'title', 'creator', 'kind', 'genre', 'subject',
  'age_range', 'location', 'tags', 'notes',
  'quantity', 'players', 'play_minutes',
  'isbn', 'isbn10', 'cover_url',
  'publisher', 'published', 'page_count', 'file_path',
  'summary',
  'source', 'enrich_state', 'created_at', 'updated_at',
];

// Never taken from the Sheet. `id` is the join key and `created_at` is history.
// `updated_at` matters most: it's set by the database on every write, so
// comparing it against the Sheet's copy would make every row look changed on
// every pull — which then writes a new timestamp and guarantees the next pull
// looks changed too. It's shown in the Sheet for information, and refreshed
// whenever a row is pushed.
const READ_ONLY_ON_PULL = new Set(['id', 'created_at', 'updated_at']);

// Stored as numbers so a spreadsheet doesn't render them as text.
const NUMERIC = new Set(['page_count', 'play_minutes', 'quantity']);

// ---------------------------------------------------------------- config

function keyFilePath() {
  const configured = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(REPO_ROOT, configured);
  }
  // Fall back to whatever service-account key is sitting in the repo root, so
  // the app works after downloading a key without editing .env.
  const found = fs
    .readdirSync(REPO_ROOT)
    .filter((f) => f.endsWith('.json') && !['package.json', 'package-lock.json'].includes(f))
    .find((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'));
        return j.type === 'service_account' && j.private_key && j.client_email;
      } catch {
        return false;
      }
    });
  return found ? path.join(REPO_ROOT, found) : null;
}

export function isConfigured() {
  if (!process.env.GOOGLE_SHEET_ID) return false;
  const kf = keyFilePath();
  return Boolean(kf && fs.existsSync(kf));
}

/** Human-readable reason syncing is off, or null when it's ready. */
export function configProblem() {
  if (!process.env.GOOGLE_SHEET_ID) {
    return 'GOOGLE_SHEET_ID is not set in .env — sheet sync is off.';
  }
  const kf = keyFilePath();
  if (!kf) return 'No service-account JSON key found. Sheet sync is off.';
  if (!fs.existsSync(kf)) return `Service-account key not found at ${kf}. Sheet sync is off.`;
  return null;
}

let cachedClient = null;
async function client() {
  if (cachedClient) return cachedClient;
  const creds = JSON.parse(fs.readFileSync(keyFilePath(), 'utf8'));
  cachedClient = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
  await cachedClient.authorize();
  return cachedClient;
}

export function serviceAccountEmail() {
  try {
    return JSON.parse(fs.readFileSync(keyFilePath(), 'utf8')).client_email;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- transport

async function call(method, url, body) {
  const auth = await client();
  const { token } = await auth.getAccessToken();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 400);
    try {
      detail = JSON.parse(text)?.error?.message || detail;
    } catch { /* keep the raw text */ }

    // Both setup mistakes return 403 but need completely different fixes, so
    // tell them apart rather than making the user guess.
    if (res.status === 403) {
      const apiDisabled = /has not been used in project|is disabled|SERVICE_DISABLED/i.test(detail);
      if (apiDisabled) {
        const project = detail.match(/project (\d+)/)?.[1];
        throw new Error(
          `The Google Sheets API isn't enabled for this project yet. Enable it at ` +
            `https://console.developers.google.com/apis/api/sheets.googleapis.com/overview` +
            (project ? `?project=${project}` : '') +
            `, then wait a minute for it to take effect. Original message: ${detail}`
        );
      }
      throw new Error(
        `The Sheet hasn't been shared with the service account. Open the Sheet, ` +
          `click Share, and add ${serviceAccountEmail()} as an Editor. ` +
          `Original message: ${detail}`
      );
    }
    if (res.status === 404) {
      throw new Error(
        `Sheet not found (404). Check GOOGLE_SHEET_ID in .env — it's the long id ` +
          `in the sheet's URL between /d/ and /edit. Original message: ${detail}`
      );
    }
    throw new Error(`Google Sheets API ${res.status}: ${detail}`);
  }
  return res.json();
}

const sheetId = () => process.env.GOOGLE_SHEET_ID;
const quoteTab = (name) => `'${String(name).replace(/'/g, "''")}'`;

/** The first tab's title and numeric gid — gid is required to delete rows. */
let cachedTab = null;
async function tab() {
  if (cachedTab) return cachedTab;
  const meta = await call(
    'GET',
    `${API}/${sheetId()}?fields=sheets.properties(sheetId,title)`
  );
  const props = meta.sheets?.[0]?.properties;
  if (!props) throw new Error('That spreadsheet has no sheets.');
  cachedTab = { title: props.title, gid: props.sheetId };
  return cachedTab;
}

const colLetter = (i) => {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
};
const LAST_COL = colLetter(SHEET_COLUMNS.length - 1);

// ---------------------------------------------------------------- mapping

function toCell(field, value) {
  if (value === null || value === undefined) return '';
  if (NUMERIC.has(field)) return Number(value);
  return String(value);
}

function rowFor(item) {
  return SHEET_COLUMNS.map((f) => toCell(f, item[f]));
}

function fromCell(field, raw) {
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  if (s === '') return null;
  if (NUMERIC.has(field)) {
    const n = Number(s.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return s;
}

/**
 * Compare a stored row against values parsed from the Sheet. Both sides are
 * normalised first: SQLite gives back `null` where a blank cell parses to
 * `null`, and numeric columns can arrive as either a number or a numeric
 * string depending on how the cell was typed.
 */
function differs(stored, incoming) {
  for (const [field, value] of Object.entries(incoming)) {
    const a = stored[field] ?? null;
    const b = value ?? null;
    if (a === null && b === null) continue;
    // A blank cell in a NOT NULL column can't clear the value — the write would
    // fall back to what's already stored. Treating it as a difference would
    // rewrite the row on every single pull without changing anything.
    if (b === null && field in NOT_NULL_DEFAULTS) continue;
    if (a === null || b === null) return true;
    if (NUMERIC.has(field)) {
      if (Number(a) !== Number(b)) return true;
    } else if (String(a) !== String(b)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- read

async function readGrid() {
  const t = await tab();
  const range = `${quoteTab(t.title)}!A1:${LAST_COL}`;
  const data = await call(
    'GET',
    `${API}/${sheetId()}/values/${encodeURIComponent(range)}?majorDimension=ROWS`
  );
  return data.values || [];
}

/**
 * Map header text -> column index, so the Sheet can be reordered by hand
 * without breaking sync. Unrecognised headers are ignored; missing ones simply
 * mean that field isn't managed from the Sheet.
 */
function headerMap(headerRow) {
  const map = new Map();
  (headerRow || []).forEach((label, i) => {
    const key = String(label || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (SHEET_COLUMNS.includes(key)) map.set(key, i);
  });
  return map;
}

// ---------------------------------------------------------------- push

/** id -> 1-based sheet row number, rebuilt from column A. */
async function rowIndex() {
  const t = await tab();
  const range = `${quoteTab(t.title)}!A1:A`;
  const data = await call(
    'GET',
    `${API}/${sheetId()}/values/${encodeURIComponent(range)}?majorDimension=COLUMNS`
  );
  const col = data.values?.[0] || [];
  const map = new Map();
  for (let i = 1; i < col.length; i++) {
    const id = Number(String(col[i]).trim());
    if (Number.isInteger(id) && id > 0) map.set(id, i + 1); // 1-based, +1 for header
  }
  return map;
}

/**
 * Drain the outbox to the Sheet. Batches aggressively — the write quota is
 * 60/min, and an enrichment run can queue ~900 changes at once.
 * Returns a summary; never throws for "not configured".
 */
export async function flushOutbox({ limit = 5000 } = {}) {
  if (!isConfigured()) return { skipped: true, reason: configProblem() };

  const queued = readOutbox(limit);
  if (!queued.length) return { updated: 0, appended: 0, deleted: 0, remaining: 0 };

  const t = await tab();
  const index = await rowIndex();

  const updates = [];   // existing rows -> values.batchUpdate
  const appends = [];   // new rows      -> values.append
  const deleteRows = []; // sheet row numbers -> spreadsheets.batchUpdate
  const handled = [];

  for (const { item_id: id, op } of queued) {
    if (op === 'delete') {
      const row = index.get(id);
      if (row) deleteRows.push(row);
      handled.push(id);
      continue;
    }
    const item = getItem(id);
    if (!item) { handled.push(id); continue; } // deleted before we got to it

    const row = index.get(id);
    if (row) {
      updates.push({
        range: `${quoteTab(t.title)}!A${row}:${LAST_COL}${row}`,
        values: [rowFor(item)],
      });
    } else {
      appends.push(rowFor(item));
    }
    handled.push(id);
  }

  if (updates.length) {
    await call('POST', `${API}/${sheetId()}/values:batchUpdate`, {
      valueInputOption: 'RAW',
      data: updates,
    });
  }

  if (appends.length) {
    const range = `${quoteTab(t.title)}!A1`;
    await call(
      'POST',
      `${API}/${sheetId()}/values/${encodeURIComponent(range)}:append` +
        `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values: appends }
    );
  }

  if (deleteRows.length) {
    // Descending, or earlier deletions shift the rows beneath them.
    const requests = [...new Set(deleteRows)]
      .sort((a, b) => b - a)
      .map((row) => ({
        deleteDimension: {
          range: { sheetId: t.gid, dimension: 'ROWS', startIndex: row - 1, endIndex: row },
        },
      }));
    await call('POST', `${API}/${sheetId()}:batchUpdate`, { requests });
  }

  clearOutbox(handled);
  return {
    updated: updates.length,
    appended: appends.length,
    deleted: deleteRows.length,
    remaining: outboxSize(),
  };
}

// ---------------------------------------------------------------- pull

/**
 * Sheet -> DB. The Sheet wins for every column it provides.
 *
 * Rows with a blank id are new items typed into the Sheet: they're inserted and
 * their assigned id is written back. Ids in the DB but absent from the Sheet
 * are treated as deletions, behind a guard — a partial API read or an
 * accidentally-cleared sheet looks identical to "she deleted 900 books", and
 * only one of those should be able to wipe the catalog.
 */
export async function pull({ force = false } = {}) {
  if (!isConfigured()) return { skipped: true, reason: configProblem() };

  const grid = await readGrid();
  if (!grid.length) {
    return { skipped: true, reason: 'The Sheet is empty — run `npm run sheet:init` first.' };
  }

  const cols = headerMap(grid[0]);
  if (!cols.has('id') || !cols.has('title')) {
    throw new Error(
      'The Sheet needs at least "id" and "title" columns in the header row. ' +
        'Run `npm run sheet:init` to lay it out correctly.'
    );
  }

  const seen = new Set();
  const toInsertBlank = [];
  let updated = 0;
  let inserted = 0;

  const apply = db.transaction(() => {
    for (let r = 1; r < grid.length; r++) {
      const row = grid[r];
      if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;

      const title = fromCell('title', row[cols.get('title')]);
      if (!title) continue; // a stray note in some cell, not an item

      const fields = {};
      for (const [field, i] of cols) {
        if (READ_ONLY_ON_PULL.has(field)) continue;
        fields[field] = fromCell(field, row[i]);
      }

      const rawId = String(row[cols.get('id')] ?? '').trim();
      const id = Number(rawId);

      if (!rawId || !Number.isInteger(id) || id <= 0) {
        toInsertBlank.push({ sheetRow: r + 1, fields });
        continue;
      }

      seen.add(id);
      const before = getItem(id);
      if (before) {
        // Only write when something actually differs. Without this every pull
        // rewrites all ~1000 rows, reindexes the whole FTS table, bumps every
        // updated_at, and reports "968 changes" on an app open where nothing
        // changed at all.
        if (differs(before, fields)) {
          upsertItemWithId(id, fields);
          updated++;
        }
      } else {
        upsertItemWithId(id, fields);
        inserted++;
      }
    }
  });

  // Suppress the outbox: these rows came from the Sheet, so pushing them
  // straight back would be a pointless round trip.
  withOutboxSuppressed(apply);

  // Rows typed by hand without an id: insert, then write the *whole* stored row
  // back. Writing only the id would leave blank cells for the NOT NULL columns,
  // so the very next pull would try to set them to null.
  const writeBacks = [];
  if (toInsertBlank.length) {
    withOutboxSuppressed(() => {
      for (const { sheetRow, fields } of toInsertBlank) {
        const nextId =
          (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM items').get().m || 0) + 1;
        const saved = upsertItemWithId(nextId, { ...fields, source: fields.source || 'sheet' });
        seen.add(nextId);
        inserted++;
        writeBacks.push({ sheetRow, values: rowFor(saved) });
      }
    });
  }

  // Deletions, behind the guard.
  const dbIds = allItemIds();
  const missing = dbIds.filter((id) => !seen.has(id));
  const threshold = Math.max(25, Math.floor(dbIds.length * 0.1));
  let deleted = 0;
  let refusedDeletes = 0;

  if (missing.length) {
    if (!force && missing.length > threshold) {
      refusedDeletes = missing.length;
    } else {
      const del = db.transaction(() => {
        for (const id of missing) if (deleteItem(id)) deleted++;
      });
      withOutboxSuppressed(del);
    }
  }

  if (writeBacks.length) {
    const t = await tab();
    await call('POST', `${API}/${sheetId()}/values:batchUpdate`, {
      valueInputOption: 'RAW',
      data: writeBacks.map(({ sheetRow, values }) => ({
        range: `${quoteTab(t.title)}!A${sheetRow}:${LAST_COL}${sheetRow}`,
        values: [values],
      })),
    });
  }

  setSyncState('last_pull_at', new Date().toISOString());

  return {
    updated, inserted, deleted, refusedDeletes, threshold,
    rows: grid.length - 1,
  };
}

// ---------------------------------------------------------------- bootstrap

/** Lay out the header row, freeze it, and write every item. One-time setup. */
export async function initSheet() {
  if (!isConfigured()) throw new Error(configProblem());

  const t = await tab();
  const items = allItems();

  await call('POST', `${API}/${sheetId()}:batchUpdate`, {
    requests: [
      {
        updateSheetProperties: {
          properties: { sheetId: t.gid, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      },
    ],
  });

  const values = [SHEET_COLUMNS, ...items.map(rowFor)];
  const range = `${quoteTab(t.title)}!A1:${LAST_COL}${values.length}`;
  await call(
    'POST',
    `${API}/${sheetId()}/values:batchUpdate`,
    { valueInputOption: 'RAW', data: [{ range, values }] }
  );

  // Everything is now mirrored, so anything queued beforehand is redundant.
  clearOutbox(readOutbox().map((r) => r.item_id));
  setSyncState('last_pull_at', new Date().toISOString());

  return { rows: items.length, tab: t.title };
}

export function lastPullAt() {
  return getSyncState('last_pull_at') || null;
}

export function sheetUrl() {
  return sheetId() ? `https://docs.google.com/spreadsheets/d/${sheetId()}/edit` : null;
}
