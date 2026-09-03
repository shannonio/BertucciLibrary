import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import {
  searchItems, getItem, insertItem, updateItem, deleteItem, stats, ITEM_KINDS,
  outboxSize,
} from './db.js';
import { lookupByIsbn, normalizeIsbn, coverFromIsbn } from './lookup.js';
import { ask, scanShelfImage, isConfigured, describeError, MODEL } from './claude.js';
import * as sheets from './sheets.js';
import * as imagesearch from './imagesearch.js';
import { COVER_DIR, localCoverFor, cacheCover, cacheStats } from './covers.js';
import { registerMealRoutes } from './meals.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 4173;

app.use(express.json({ limit: '2mb' }));
const PUBLIC_DIR = path.join(here, '..', 'public');

/**
 * Serve index.html with version-stamped asset URLs.
 *
 * `Cache-Control: no-cache` is not enough on its own: Chrome keeps ES modules
 * in a per-document module map and will happily re-run a stale app.js. Stamping
 * the URL with each file's mtime makes an edited file a genuinely different
 * URL, so phones pick up changes instead of running an old build for days.
 */
function serveIndex(req, res, next) {
  try {
    let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    for (const asset of ['app.js', 'styles.css']) {
      const stamp = Math.floor(fs.statSync(path.join(PUBLIC_DIR, asset)).mtimeMs);
      html = html.replaceAll(`/${asset}"`, `/${asset}?v=${stamp}"`);
    }
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
}

app.get('/', serveIndex);
app.get('/index.html', serveIndex);

app.use(
  express.static(PUBLIC_DIR, {
    index: false, // '/' is handled above so the stamping always runs
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);

// Cached cover art. Filenames are content-addressed, so a given URL always maps
// to the same file and it can be cached hard — this is what makes the grid feel
// instant on a phone.
app.use(
  '/covers',
  express.static(COVER_DIR, {
    immutable: true,
    maxAge: '30d',
  })
);

// A cached file that's been deleted should 404 so the <img> onerror fires and
// the item falls back to its typeset card. Without this the static handler
// falls through to the JSON API's error path and returns a 500.
app.use('/covers', (req, res) => res.status(404).end());

// ---------------------------------------------------------------- Meal planner
//
// The planner page, its uploaded recipe cards, and the small API behind them.
// See server/meals.js — the week plan itself stays in the browser.
registerMealRoutes(app);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------- Sheet sync
//
// Pushes are fire-and-forget: a write must never fail or hang because Google is
// slow or unreachable. Anything that doesn't make it stays in the outbox and
// goes out with the next flush.

let flushTimer = null;
function scheduleFlush() {
  if (!sheets.isConfigured() || flushTimer) return;
  // Coalesce bursts (e.g. "Add all" on a photo scan) into one API round trip.
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try {
      await sheets.flushOutbox();
    } catch (err) {
      console.warn(`  sheet push deferred: ${err.message}`);
    }
  }, 600);
}

// ---------------------------------------------------------------- Meta

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    claude: isConfigured(),
    model: isConfigured() ? MODEL : null,
    sheet: {
      configured: sheets.isConfigured(),
      problem: sheets.configProblem(),
      url: sheets.sheetUrl(),
      lastPullAt: sheets.lastPullAt(),
      pending: outboxSize(),
    },
    imageSearch: {
      configured: imagesearch.isConfigured(),
      problem: imagesearch.configProblem(),
    },
  });
});

app.post('/api/sync', wrap(async (req, res) => {
  if (!sheets.isConfigured()) {
    return res.status(503).json({ error: sheets.configProblem() });
  }
  try {
    // Push first so local changes aren't overwritten by a pull that predates them.
    const pushed = await sheets.flushOutbox();
    const pulled = await sheets.pull({ force: req.query.force === '1' });
    res.json({ pushed, pulled, lastPullAt: sheets.lastPullAt() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.get('/api/stats', (req, res) => res.json(stats()));

app.get('/api/kinds', (req, res) => res.json({ kinds: ITEM_KINDS }));

// ---------------------------------------------------------------- Items

/**
 * Serve the locally cached copy of a cover when we hold one, while leaving the
 * stored value alone — the catalog and the Sheet keep the original URL as the
 * record of where the art came from. `cover_source` exposes that original for
 * anything that wants it.
 */
function withLocalCover(item) {
  if (!item?.cover_url) return item;
  const local = localCoverFor(item.cover_url);
  if (!local || local === item.cover_url) return item;
  return { ...item, cover_url: local, cover_source: item.cover_url };
}

/**
 * Pull a cover into the local cache in the background. Fire-and-forget: a slow
 * or dead image host must never delay the response the user is waiting on.
 */
function cacheCoverSoon(item) {
  if (!item?.cover_url || localCoverFor(item.cover_url)) return;
  cacheCover(item.cover_url).catch(() => {});
}

app.get('/api/items', (req, res) => {
  const { q, kind, genre, subject, limit, offset } = req.query;
  const { rows, total } = searchItems({ q, kind, genre, subject, limit, offset });
  res.json({ items: rows.map(withLocalCover), total, offset: Number(offset) || 0 });
});

app.get('/api/items/:id', (req, res) => {
  const item = getItem(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(withLocalCover(item));
});

app.post('/api/items', (req, res) => {
  const body = req.body || {};
  if (!body.title || !String(body.title).trim()) {
    return res.status(400).json({ error: 'A title is required.' });
  }
  if (body.kind && !ITEM_KINDS.includes(body.kind)) {
    return res.status(400).json({ error: `kind must be one of: ${ITEM_KINDS.join(', ')}` });
  }
  const item = insertItem({ ...body, source: body.source || 'manual' });
  cacheCoverSoon(item);
  scheduleFlush();
  res.status(201).json(withLocalCover(item));
});

app.patch('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getItem(id)) return res.status(404).json({ error: 'Not found' });
  const item = updateItem(id, req.body || {});
  cacheCoverSoon(item);
  scheduleFlush();
  res.json(withLocalCover(item));
});

app.delete('/api/items/:id', (req, res) => {
  const ok = deleteItem(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Not found' });
  scheduleFlush();
  res.json({ deleted: true });
});

// ---------------------------------------------------------------- Image search

app.get('/api/image-search', wrap(async (req, res) => {
  // Called with ?id= so the server can build a query from the item, or ?q=
  // once the user edits it.
  let query = String(req.query.q || '').trim();
  let kind = String(req.query.kind || 'book');

  if (req.query.id) {
    const item = getItem(Number(req.query.id));
    if (!item) return res.status(404).json({ error: 'Not found' });
    kind = item.kind;
    if (!query) query = imagesearch.suggestedQuery(item);
  }
  if (!query) return res.status(400).json({ error: 'Nothing to search for.' });

  try {
    const results = await imagesearch.searchImages(query, { kind });
    res.json({ query, kind, searchable: imagesearch.canSearch(kind), results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

/**
 * Attach a chosen image to an item.
 *
 * The image is downloaded first and only saved if that succeeds — so a picture
 * that can't be fetched is rejected while the picker is still open, rather than
 * becoming a broken cover you discover later.
 */
app.post('/api/items/:id/cover', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!getItem(id)) return res.status(404).json({ error: 'Not found' });

  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'That is not a valid image URL.' });
  }

  const cached = await cacheCover(url);
  if (!cached.path) {
    return res.status(422).json({
      error: `Could not fetch that image (${cached.error}). Try a different one.`,
    });
  }

  const item = updateItem(id, { cover_url: url });
  scheduleFlush();
  res.json(withLocalCover(item));
}));

// ---------------------------------------------------------------- ISBN lookup

app.get('/api/lookup/isbn/:isbn', wrap(async (req, res) => {
  const isbn = normalizeIsbn(req.params.isbn);
  if (!isbn) {
    return res.status(400).json({ error: 'That does not look like a valid ISBN-10 or ISBN-13.' });
  }
  const meta = await lookupByIsbn(isbn);
  if (!meta) {
    return res.status(404).json({
      error: 'No record found for that ISBN.',
      // Still offer a cover guess so the user can add the book manually.
      fallback: { isbn, cover_url: coverFromIsbn(isbn) },
    });
  }
  res.json(meta);
}));

// ---------------------------------------------------------------- Photo scan

app.post('/api/scan', upload.single('photo'), wrap(async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({
      error: 'Photo scanning needs a Claude API key. Add ANTHROPIC_API_KEY to .env and restart.',
    });
  }
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded.' });

  const mediaType = req.file.mimetype;
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) {
    return res.status(400).json({ error: `Unsupported image type: ${mediaType}` });
  }

  let detected;
  try {
    detected = await scanShelfImage({
      base64: req.file.buffer.toString('base64'),
      mediaType,
    });
  } catch (err) {
    return res.status(502).json({ error: describeError(err) });
  }

  // Resolve each detected title to real metadata, and flag anything we
  // already own so the review screen can warn about duplicates.
  const { lookupByTitle } = await import('./lookup.js');
  const candidates = await Promise.all(
    detected.map(async (b) => {
      let meta = null;
      try {
        meta = await lookupByTitle(b.title, b.author);
      } catch { /* leave meta null; the user can still add it manually */ }

      const { rows } = searchItems({ q: b.title, limit: 3 });
      const dup = rows.find(
        (r) => r.title.toLowerCase().trim() === (meta?.title || b.title).toLowerCase().trim()
      );

      return {
        detected: { title: b.title, author: b.author, confidence: b.confidence },
        title: meta?.title || b.title,
        creator: meta?.creator || b.author || null,
        isbn: meta?.isbn || null,
        cover_url: meta?.cover_url || null,
        publisher: meta?.publisher || null,
        published: meta?.published || null,
        page_count: meta?.page_count || null,
        subject: meta?.subject || null,
        summary: meta?.summary || null,
        resolved: Boolean(meta?.isbn || meta?.cover_url),
        duplicate_of: dup ? { id: dup.id, title: dup.title } : null,
      };
    })
  );

  res.json({ candidates });
}));

// ---------------------------------------------------------------- Ask Claude

app.post('/api/ask', wrap(async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!messages?.length) {
    return res.status(400).json({ error: 'messages[] is required.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Abort the Claude call if the phone navigates away mid-answer.
  // This must listen on `res`, not `req`: on a POST, `req`'s 'close' fires as
  // soon as the request body has been consumed, which would cancel every
  // request the instant it started.
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  await ask({ messages, onEvent: send, signal: controller.signal });
  if (!res.writableEnded) res.end();
}));

// ---------------------------------------------------------------- Errors

app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That photo is too large (12 MB max).' });
  }
  // A malformed request body is the caller's fault, not a server fault —
  // body-parser surfaces it as a SyntaxError, which would otherwise 500.
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Request body was not valid JSON.' });
  }
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: String(err?.message || 'Server error') });
});

// ---------------------------------------------------------------- Start

/**
 * The address to hand out for phones on the same WiFi. Macs commonly have
 * several non-internal IPv4 interfaces (VPNs, Docker/VM bridges, iPhone
 * tethering), so prefer the real Wi-Fi/Ethernet ones by name.
 */
function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const isPhysical = /^(en|eth|wl)\d/.test(name);
      candidates.push({ name, address: a.address, rank: isPhysical ? 0 : 1 });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return candidates[0]?.address || 'localhost';
}

// Bind address. Default is every interface, which is what you want when the
// phone reaches the Mac directly over WiFi. Behind `tailscale serve`, set
// HOST=127.0.0.1 so the app is reachable *only* through Tailscale and not from
// the local network as well.
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, async () => {
  const s = stats();
  console.log(`\n  Bertucci Library`);
  console.log(`  ${s.total} items · ${s.withCovers} covers · ${s.withIsbn} ISBNs`);
  console.log(`  Claude: ${isConfigured() ? `ready (${MODEL})` : 'not configured — set ANTHROPIC_API_KEY in .env'}`);
  console.log(`  Sheet:  ${sheets.isConfigured() ? 'connected' : sheets.configProblem()}`);

  if (process.env.PUBLIC_URL) {
    console.log(`\n  Serving at: ${process.env.PUBLIC_URL}`);
    console.log(`  Listening on ${HOST}:${PORT}\n`);
  } else if (HOST === '127.0.0.1' || HOST === 'localhost') {
    console.log(`\n  On this machine: http://localhost:${PORT}`);
    console.log(`  (bound to localhost only — put a proxy in front to share it)\n`);
  } else {
    console.log(`\n  On this Mac:  http://localhost:${PORT}`);
    console.log(`  On your phone: http://${lanAddress()}:${PORT}\n`);
  }

  // Drain anything queued while the server was down, then take the Sheet's
  // version of the world. Failures here are non-fatal — the app runs fine on
  // SQLite alone, and the outbox keeps the changes for next time.
  if (sheets.isConfigured()) {
    try {
      const pending = outboxSize();
      if (pending) {
        const pushed = await sheets.flushOutbox();
        console.log(`  pushed ${pending} queued change(s) to the Sheet:`, pushed);
      }
      const r = await sheets.pull();
      if (r.skipped) console.log(`  sheet pull skipped: ${r.reason}`);
      else {
        console.log(
          `  pulled from Sheet: ${r.updated} updated, ${r.inserted} added, ${r.deleted} removed`
        );
        if (r.refusedDeletes) {
          console.log(
            `  refused to delete ${r.refusedDeletes} items (threshold ${r.threshold}) — ` +
              'run: npm run sheet:pull -- --force  if that was intentional'
          );
        }
      }
    } catch (err) {
      console.warn(`  sheet sync unavailable: ${err.message}`);
    }
  }
});
