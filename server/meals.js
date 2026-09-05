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
 * The week plan moved here later, for the same reason and after the same
 * complaint: a week dragged together on the laptop did not exist on the iPad,
 * which is most of what a meal planner is for. Plans live in their own
 * document, one entry per week.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import express from 'express';
import { fileURLToPath } from 'url';
import { readIngredients, readIngredientsFromFile, mediaTypeFor } from './mealIngredients.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.join(here, '..', 'meal_planner_dashboard');
const ASSET_DIR = path.join(DASHBOARD_DIR, 'assets');
export const MEAL_CARD_DIR = path.join(here, '..', 'data', 'meal-cards');
// The images sit in their own subdirectory because that whole subdirectory is
// served over HTTP. library.json holds the titles and tags and must not be
// reachable, so it stays a level up rather than being filtered out of the
// static handler — a filter there is one mistake away from serving it.
const IMAGE_DIR = path.join(MEAL_CARD_DIR, 'images');
const LIBRARY_FILE = path.join(MEAL_CARD_DIR, 'library.json');

// The week plans are family data like the library, but they are not cards and
// nothing here is ever served as a file, so they get a directory of their own
// rather than a filename inside the one that is.
export const MEAL_PLAN_DIR = path.join(here, '..', 'data', 'meal-plans');
const PLAN_FILE = path.join(MEAL_PLAN_DIR, 'plans.json');

fs.mkdirSync(IMAGE_DIR, { recursive: true });
fs.mkdirSync(MEAL_PLAN_DIR, { recursive: true });

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
// be able to leave a half-written document that reads as valid JSON tomorrow.
function writeJSON(file, doc) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.part`);
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
}

function writeLibrary(doc) {
  writeJSON(LIBRARY_FILE, doc);
}

// ---------------------------------------------------------------- the plans
//
// One document holds every week, keyed by the Sunday it starts on; a week is a
// flat map of "YYYY-MM-DD|Meal" to the recipe ids planned in it. A week is ids
// and dates and nothing else, so the whole history is a few kilobytes and the
// page can hold all of it — which is what makes stepping between weeks cost no
// requests, exactly as it did when this lived in localStorage.

const MEAL_SLOTS = ['Breakfast', 'Lunch', 'Dinner', 'Other'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PER_SLOT = 24;
const MAX_WEEKS_PER_MERGE = 400;

function readPlans() {
  try {
    const doc = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
    return {
      version: 1,
      weeks: doc.weeks && typeof doc.weeks === 'object' ? doc.weeks : {},
      // What has been ticked off the shopping list, per week. It lives beside
      // the plan rather than in the browser for the same reason the plan does:
      // the list is read in a shop, on a phone, by whoever is standing in the
      // aisle — and the other person at home should see it empty out.
      checked: doc.checked && typeof doc.checked === 'object' ? doc.checked : {},
      updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`  meal plans unreadable: ${err.message}`);
    return { version: 1, weeks: {}, checked: {}, updatedAt: null };
  }
}

function writePlans(doc) {
  doc.updatedAt = new Date().toISOString();
  writeJSON(PLAN_FILE, doc);
  return doc;
}

// Local date parts, never toISOString(): a date is a calendar day here, and
// pushing it through UTC is how a Sunday becomes the Saturday before it.
function isoDate(dt) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function parseDate(raw) {
  if (!DATE_RE.test(String(raw || ''))) return null;
  const [y, m, d] = raw.split('-').map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  // Rejects 2026-02-31, which Date would roll forward into March.
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

/**
 * A week is named by the Sunday it starts on. Insisting on that here rather
 * than rounding a stray date down is deliberate: a browser that disagreed
 * about where a week begins would file meals in a bucket no other browser
 * looks in, and silently rounding would hide that instead of showing it.
 */
function validWeek(raw) {
  const dt = parseDate(raw);
  return dt && dt.getDay() === 0 ? isoDate(dt) : null;
}

function cleanSlots(week, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const start = parseDate(week);
  const days = new Set();
  for (let i = 0; i < 7; i++) {
    const dt = new Date(start);
    dt.setDate(dt.getDate() + i);
    days.add(isoDate(dt));
  }

  const slots = {};
  for (const [key, ids] of Object.entries(raw)) {
    const [date, meal] = String(key).split('|');
    // A slot outside the week it is filed under would never be drawn, and would
    // ride along in the document forever. Drop it rather than store it.
    if (!days.has(date) || !MEAL_SLOTS.includes(meal) || !Array.isArray(ids)) continue;
    const clean = ids
      .map((id) => String(id).trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, MAX_PER_SLOT);
    if (clean.length) slots[`${date}|${meal}`] = clean;
  }
  return slots;
}

const countOf = (list, id) => list.filter((x) => x === id).length;

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

// Ingredients are lines, not a blob: the shopping list needs to count them and
// tick them off one at a time. Stored as typed — "2 cups all-purpose flour" —
// because a card's own wording is the thing a person recognises in the aisle,
// and any attempt to parse a quantity out of it would be wrong often enough to
// be worse than useless.
function cleanIngredients(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split('\n');
  return list
    .map((line) => String(line).replace(/\s+/g, ' ').trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 80);
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
        ingredients: cleanIngredients(req.body.ingredients),
        image: imageUrl,
        thumb: thumbUrl || imageUrl,
        addedAt: new Date().toISOString(),
      };

      // Read the ingredients off the card being uploaded, unless the caller
      // sent their own. Best-effort throughout: the card is what the person
      // asked to save, and no failure here is allowed to lose it. What went
      // wrong comes back beside the card so the page can say so.
      let ingredientsError = null;
      if (!card.ingredients.length) {
        try {
          const mediaType = mediaTypeFor(imageUrl);
          if (!mediaType) throw new Error('That image type cannot be read for ingredients.');
          card.ingredients = await readIngredients({
            base64: image.buffer.toString('base64'),
            mediaType,
          });
        } catch (err) {
          console.warn(`  could not read ingredients from ${card.title}: ${err.message}`);
          ingredientsError = err.message;
        }
      }

      const doc = readLibrary();
      // An id that already exists means a re-sent migration, not a new card.
      if (doc.custom.some((c) => c.id === card.id)) {
        return res.json({ card: doc.custom.find((c) => c.id === card.id), duplicate: true });
      }
      doc.custom.push(card);
      writeLibrary(doc);
      res.json({ card, ingredientsError });
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
      ingredients: cleanIngredients(req.body.ingredients),
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

  // Read (or re-read) the ingredients off a card already in the library. The
  // upload path does this once; this is how the cards that predate it get
  // theirs, and how a card whose reading came out wrong gets another go.
  //
  // A custom card owns its record so the lines are written into it; a built-in
  // card is a const in the page, so they are stored as an override — exactly
  // the split the title and tags already use.
  app.post('/api/meals/cards/:id/ingredients', wrap(async (req, res) => {
    const id = req.params.id;
    const doc = readLibrary();
    const existing = doc.custom.find((c) => c.id === id);

    // Only ever a path this server built: a custom card's stored upload, or a
    // built-in asset resolved by basename. The id never becomes a path.
    let file;
    if (existing) {
      file = path.join(IMAGE_DIR, path.basename(existing.image || ''));
    } else {
      const asset = String(req.body?.image || '').replace(/^assets\//, '');
      const resolved = path.join(ASSET_DIR, path.basename(asset));
      if (!asset || !fs.existsSync(resolved)) {
        return res.status(404).json({ error: 'No card image to read.' });
      }
      file = resolved;
    }
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'No card image to read.' });

    const ingredients = cleanIngredients(await readIngredientsFromFile(file));
    if (!ingredients.length) {
      return res.status(422).json({ error: 'Nothing readable as an ingredient list on that card.' });
    }

    if (existing) existing.ingredients = ingredients;
    else doc.overrides[id] = { ...(doc.overrides[id] || {}), ingredients };
    writeLibrary(doc);
    res.json({ ok: true, id, ingredients });
  }));

  // ------------------------------------------------------------ week plans
  //
  // Every week in one response. It is small — see readPlans — and sending the
  // lot is what lets the page page back through the year without a request per
  // week, the way it did when this was localStorage.
  app.get('/api/meals/plan', (req, res) => res.json(readPlans()));

  // One week, replaced wholesale. Replacing rather than patching keeps the
  // page's own model of a week as the single description of it, and bounds
  // what two devices editing at once can cost each other to the week they are
  // both on rather than the whole year.
  //
  // No await between the read and the write, so two requests cannot interleave
  // and lose one of themselves.
  app.put('/api/meals/plan/:week', (req, res) => {
    const week = validWeek(req.params.week);
    if (!week) {
      return res.status(400).json({ error: 'A week must be the Sunday it starts on, as YYYY-MM-DD.' });
    }
    const slots = cleanSlots(week, req.body?.slots);
    if (!slots) return res.status(400).json({ error: 'slots must be an object.' });

    const doc = readPlans();
    // An emptied week is a week with nothing planned in it, which is what an
    // absent key already means. Keeping it would only grow the document.
    if (Object.keys(slots).length) {
      doc.weeks[week] = slots;
    } else {
      // A week with nothing planned has nothing to shop for either.
      delete doc.weeks[week];
      delete doc.checked[week];
    }
    writePlans(doc);
    res.json({ ok: true, week, slots, updatedAt: doc.updatedAt });
  });

  // What has been ticked off this week's shopping list, replaced wholesale.
  // The ticks are the ingredient lines themselves rather than indices into the
  // list: the list is derived from the plan, so a meal added mid-shop would
  // renumber every index under whoever is holding the phone. A line that is no
  // longer needed simply stops matching anything, which is also how the set
  // prunes itself.
  app.put('/api/meals/plan/:week/checked', (req, res) => {
    const week = validWeek(req.params.week);
    if (!week) {
      return res.status(400).json({ error: 'A week must be the Sunday it starts on, as YYYY-MM-DD.' });
    }
    const raw = req.body?.checked;
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'checked must be an array.' });

    const checked = [
      ...new Set(
        raw.map((line) => String(line).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200))
           .filter(Boolean)
      ),
    ].slice(0, 400);

    const doc = readPlans();
    if (checked.length) doc.checked[week] = checked;
    else delete doc.checked[week];
    writePlans(doc);
    res.json({ ok: true, week, checked, updatedAt: doc.updatedAt });
  });

  // The one-off carry-up of weeks a browser planned before any of this
  // existed. It only ever adds: nothing is removed, and an id already in a
  // slot is not doubled — so running it on the laptop and then the iPad ends
  // with everything both of them had, in either order, rather than whichever
  // happened to go last.
  app.post('/api/meals/plan/merge', (req, res) => {
    const incoming = req.body?.weeks;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'weeks must be an object.' });
    }

    const doc = readPlans();
    let added = 0;
    for (const [rawWeek, rawSlots] of Object.entries(incoming).slice(0, MAX_WEEKS_PER_MERGE)) {
      const week = validWeek(rawWeek);
      if (!week) continue;
      const slots = cleanSlots(week, rawSlots);
      if (!slots || !Object.keys(slots).length) continue;

      const into = doc.weeks[week] || {};
      for (const [slot, ids] of Object.entries(slots)) {
        const merged = (into[slot] || []).slice();
        for (const id of new Set(ids)) {
          // Union by count rather than by presence. The same card twice in one
          // slot on one device is two helpings and must survive; the same card
          // arriving from a second device is the same meal seen twice. Taking
          // the larger count is both, and re-running changes nothing.
          for (let n = countOf(merged, id); n < countOf(ids, id); n++) {
            merged.push(id);
            added++;
          }
        }
        into[slot] = merged.slice(0, MAX_PER_SLOT);
      }
      doc.weeks[week] = into;
    }
    writePlans(doc);
    res.json({ ok: true, added, weeks: doc.weeks, updatedAt: doc.updatedAt });
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
  const weeks = Object.keys(readPlans().weeks).length;
  // (checked sets are per-week and not worth counting separately here)
  return { uploads: files.length, cards: doc.custom.length, hidden: doc.hidden.length, weeks, mb: (bytes / 1024 / 1024).toFixed(1) };
}
