/**
 * Local cover cache.
 *
 * Cover URLs point at other people's servers — Open Library, Google, BGG's CDN.
 * Any of them can start blocking hotlinks, reorganise their paths, or go away,
 * and every cover in the app breaks at once with no warning.
 *
 * So each image is fetched once and kept in data/covers/. The catalog still
 * stores the original URL (that's what the Sheet shows, and it's the record of
 * where the art came from), but the app renders /covers/<hash>.<ext>, served
 * from disk. Fast on a phone, and immune to the source disappearing later.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const COVER_DIR = path.join(here, '..', 'data', 'covers');
fs.mkdirSync(COVER_DIR, { recursive: true });

const UA = 'BertucciLibrary/0.1 (personal home library catalog)';
const MAX_BYTES = 8 * 1024 * 1024;

const EXT_FOR_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

/** Stable filename per URL, so re-running never re-downloads the same image. */
export function cacheKey(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
}

function findCached(key) {
  for (const ext of ['.jpg', '.png', '.webp', '.gif', '.avif']) {
    const p = path.join(COVER_DIR, key + ext);
    if (fs.existsSync(p)) return key + ext;
  }
  return null;
}

/** The local path for a URL if we hold it, else null. */
export function localCoverFor(url) {
  if (!url) return null;
  if (String(url).startsWith('/covers/')) return url; // already local
  const name = findCached(cacheKey(url));
  return name ? `/covers/${name}` : null;
}

/**
 * Download a cover if we don't already hold it.
 * Returns { path, cached, skipped, error } — never throws, because a failed
 * cover should never break an import or a sync.
 */
export async function cacheCover(url) {
  if (!url || String(url).startsWith('/covers/')) {
    return { path: url || null, cached: false, skipped: true };
  }

  const key = cacheKey(url);
  const existing = findCached(key);
  if (existing) return { path: `/covers/${existing}`, cached: false, skipped: true };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return { path: null, cached: false, error: `HTTP ${res.status}` };

    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_FOR_TYPE[type];
    if (!ext) return { path: null, cached: false, error: `not an image (${type || 'unknown'})` };

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      return { path: null, cached: false, error: `too large (${Math.round(buf.length / 1024)}KB)` };
    }
    // Open Library serves a 1x1 placeholder instead of a 404 for missing art.
    if (buf.length < 1024) {
      return { path: null, cached: false, error: 'placeholder or empty image' };
    }

    // Write to a temp name first so an interrupted download can't leave a
    // truncated file that later looks like a valid cache hit.
    const finalName = key + ext;
    const tmp = path.join(COVER_DIR, `.${finalName}.part`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, path.join(COVER_DIR, finalName));

    return { path: `/covers/${finalName}`, cached: true, bytes: buf.length };
  } catch (err) {
    return {
      path: null,
      cached: false,
      error: err.name === 'AbortError' ? 'timed out' : String(err.message || err),
    };
  }
}

export function cacheStats() {
  const files = fs.readdirSync(COVER_DIR).filter((f) => !f.startsWith('.'));
  const bytes = files.reduce(
    (n, f) => n + fs.statSync(path.join(COVER_DIR, f)).size,
    0
  );
  return { files: files.length, bytes, mb: (bytes / 1024 / 1024).toFixed(1) };
}
