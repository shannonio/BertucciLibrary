/**
 * The meal planner's recipe library.
 *
 * The planner used to keep everything a person added in their own browser —
 * uploaded card images in IndexedDB, edits and removals in localStorage. That
 * made every device its own island: a card added on the iPad did not exist on
 * anyone else's screen, and clearing site data threw the lot away.
 *
 * So the library now lives here instead. Uploads are written to
 * data/meal-cards/, and the titles, tags and removals that go with them sit in
 * one JSON document beside the images. Every browser reads the same library.
 *
 * The images are deliberately NOT written into meal_planner_dashboard/assets/,
 * even though that is where the twenty built-in cards live. That directory is
 * checked into git; this is family data that is not, and mixing the two would
 * put uploads one `git clean` away from being deleted.
 *
 * What still belongs to the browser is the week plan itself. Nothing here
 * touches it.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import express from 'express';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.join(here, '..', 'meal_planner_dashboard');
export const MEAL_CARD_DIR = path.join(here, '..', 'data', 'meal-cards');
// The images sit in their own subdirectory because that whole subdirectory is
// served over HTTP. library.json holds the titles and tags and must not be
// reachable, so it stays a level up rather than being filtered out of the
// static handler — a filter there is one mistake away from serving it.
const IMAGE_DIR = path.join(MEAL_CARD_DIR, 'images');
const LIBRARY_FILE = path.join(MEAL_CARD_DIR, 'library.json');

fs.mkdirSync(IMAGE_DIR, { recursive: true });

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const CATEGORIES = ['Breakfast', 'Lunch', 'Dinner', 'Other'];

const EXT_FOR_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

// ---------------------------------------------------------------- the document

const EMPTY = { version: 1, custom: [], overrides: {}, hidden: [] };

function readLibrary() {
  try {
    const doc = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
    return {
      version: 1,
      custom: Array.isArray(doc.custom) ? doc.custom : [],
      overrides: doc.overrides && typeof doc.overrides === 'object' ? doc.overrides : {},
      hidden: Array.isArray(doc.hidden) ? doc.hidden : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`  meal library unreadable: ${err.message}`);
    return { ...EMPTY, custom: [], overrides: {}, hidden: [] };
  }
}

// Temp file then rename, the same as a cached cover: a crash mid-write must not
// be able to leave a half-written library that reads as valid JSON tomorrow.
function writeLibrary(doc) {
  const tmp = path.join(MEAL_CARD_DIR, '.library.json.part');
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, LIBRARY_FILE);
}

// ---------------------------------------------------------------- helpers

function cleanTags(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
}

function cleanCategory(raw) {
  return CATEGORIES.includes(raw) ? raw : 'Other';
}

function cleanTitle(raw) {
  return String(raw || '').trim().slice(0, 160);
}

/** Our own filename, always — a client-supplied one is not to be trusted. */
function storeImage(file, suffix) {
  const type = (file.mimetype || '').toLowerCase();
  const ext = EXT_FOR_TYPE[type];
  if (!ext) return null;
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}${suffix}${ext}`;
  const tmp = path.join(IMAGE_DIR, `.${name}.part`);
  fs.writeFileSync(tmp, file.buffer);
  fs.renameSync(tmp, path.join(IMAGE_DIR, name));
  return `/meals/uploads/${name}`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 2 },
  fileFilter: (req, file, cb) => cb(null, (file.mimetype || '').startsWith('image/')),
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------- routes

export function registerMealRoutes(app) {
  // Uploaded card images. Each filename is unique to its upload, so a given URL
  // always maps to the same bytes and can be cached hard.
  app.use(
    '/meals/uploads',
    express.static(IMAGE_DIR, { immutable: true, maxAge: '30d', index: false })
  );
  app.use('/meals/uploads', (req, res) => res.status(404).end());

  app.get('/api/meals/library', (req, res) => res.json(readLibrary()));

  // Add a card. `image` is the full-resolution card; `thumb` is the small
  // version the browser made for the grid, which is optional — without it the
  // grid just points at the full image.
  app.post(
    '/api/meals/cards',
    upload.fields([{ name: 'image', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]),
    wrap(async (req, res) => {
      const image = req.files?.image?.[0];
      const title = cleanTitle(req.body.title);
      if (!image) return res.status(400).json({ error: 'An image file is required.' });
      if (!title) return res.status(400).json({ error: 'A recipe name is required.' });

      const imageUrl = storeImage(image, '');
      if (!imageUrl) {
        return res.status(415).json({ error: `Unsupported image type: ${image.mimetype}` });
      }
      const thumbFile = req.files?.thumb?.[0];
      const thumbUrl = thumbFile ? storeImage(thumbFile, '-thumb') : null;

      const card = {
        id: req.body.id && String(req.body.id).slice(0, 60) || `u${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
        title,
        category: cleanCategory(req.body.category),
        tags: cleanTags(req.body.tags),
        image: imageUrl,
        thumb: thumbUrl || imageUrl,
        addedAt: new Date().toISOString(),
      };

      const doc = readLibrary();
      // An id that already exists means a re-sent migration, not a new card.
      if (doc.custom.some((c) => c.id === card.id)) {
        return res.json({ card: doc.custom.find((c) => c.id === card.id), duplicate: true });
      }
      doc.custom.push(card);
      writeLibrary(doc);
      res.json({ card });
    })
  );

  // Retitle / retag. A custom card owns its record so the edit goes into it; a
  // built-in card is a const in the page, so its edit is stored as an override
  // keyed by id and the original text stays intact underneath.
  app.patch('/api/meals/cards/:id', express.json(), (req, res) => {
    const doc = readLibrary();
    const id = req.params.id;
    const existing = doc.custom.find((c) => c.id === id);
    const patch = {
      title: cleanTitle(req.body.title),
      category: cleanCategory(req.body.category),
      tags: cleanTags(req.body.tags),
    };
    if (!patch.title) return res.status(400).json({ error: 'A recipe name is required.' });

    if (existing) Object.assign(existing, patch);
    else doc.overrides[id] = patch;
    writeLibrary(doc);
    res.json({ ok: true, card: existing || { id, ...patch } });
  });

  // Removing takes a card out of the library without deleting anything: the
  // image stays on disk and the id still resolves, so a week that already uses
  // the card keeps rendering exactly as it was.
  app.delete('/api/meals/cards/:id', (req, res) => {
    const doc = readLibrary();
    if (!doc.hidden.includes(req.params.id)) doc.hidden.push(req.params.id);
    writeLibrary(doc);
    res.json({ ok: true, hidden: doc.hidden });
  });

  app.post('/api/meals/cards/:id/restore', (req, res) => {
    const doc = readLibrary();
    doc.hidden = doc.hidden.filter((h) => h !== req.params.id);
    writeLibrary(doc);
    res.json({ ok: true, hidden: doc.hidden });
  });

  app.post('/api/meals/hidden/clear', (req, res) => {
    const doc = readLibrary();
    doc.hidden = [];
    writeLibrary(doc);
    res.json({ ok: true, hidden: [] });
  });

  // The planner page itself.
  app.use(
    '/meals',
    express.static(DASHBOARD_DIR, {
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        // The built-in cards are ~3 MB PNGs that never change once written, so
        // they cache hard. The page itself must not, or an edit would take a
        // week to reach the iPad.
        res.setHeader(
          'Cache-Control',
          filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=604800, immutable'
        );
      },
    })
  );

  // Same reason as /covers: without this, a missing card falls through to the
  // JSON API's error path and returns a 500 instead of a 404.
  app.use('/meals', (req, res) => res.status(404).end());
}

export function mealStats() {
  const files = fs.readdirSync(IMAGE_DIR).filter((f) => !f.startsWith('.'));
  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(IMAGE_DIR, f)).size, 0);
  const doc = readLibrary();
  return { uploads: files.length, cards: doc.custom.length, hidden: doc.hidden.length, mb: (bytes / 1024 / 1024).toFixed(1) };
}
