/**
 * Cover image search for the in-app picker.
 *
 * This originally used Google's Custom Search JSON API. That turned out to be
 * closed to new customers (and is discontinued entirely on 2027-01-01), so it
 * can never work here regardless of setup. These sources were chosen because
 * they need no new credentials and are verified working:
 *
 *   Books — Google Books (many editions, each with its own cover art) plus
 *           Open Library. Between them most books have several covers to pick
 *           from, which is exactly what a picker wants.
 *   Games — no free catalog carries board game box art (see README). The picker
 *           falls back to pasting a URL, which is a first-class path here.
 */
import { normalizeIsbn, coverFromIsbn, coverExists } from './lookup.js';
import * as bgg from './bgg.js';

const UA = 'BertucciLibrary/0.1 (personal home library catalog)';

/** Always available: Books works keyless, and pasting a URL needs nothing. */
export function isConfigured() {
  return true;
}

export function configProblem() {
  return null;
}

/** Search terms to start from. Kept plain — these hit catalog APIs, not a web index. */
export function suggestedQuery(item) {
  if (!item) return '';
  if (item.kind === 'boardgame') return item.title;
  const author = (item.creator || '').replace(/\s*\([^)]*\)/g, '').split(/[,;]/)[0].trim();
  return [item.title, author].filter(Boolean).join(' ');
}

/**
 * True when this kind of item has an automatic image source. Games only have
 * one once a BGG token is configured — without it, pasting is the path.
 */
export function canSearch(kind) {
  return kind === 'boardgame' ? bgg.isConfigured() : true;
}

async function getJSON(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Google Books — the richest source of alternate cover art per title. */
async function fromGoogleBooks(query) {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  const url =
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}` +
    `&maxResults=20&printType=books` + (key ? `&key=${key}` : '');
  const data = await getJSON(url);

  const out = [];
  for (const item of data?.items || []) {
    const v = item.volumeInfo;
    const links = v?.imageLinks;
    if (!links) continue;

    // Ask for a larger render than the default thumbnail, which is tiny.
    const big = (links.extraLarge || links.large || links.medium || links.thumbnail || '')
      .replace(/^http:/, 'https:')
      .replace(/&zoom=\d/, '&zoom=1')
      .replace(/&edge=curl/, '');
    if (!big) continue;

    out.push({
      url: big,
      thumbnail: (links.smallThumbnail || links.thumbnail || big).replace(/^http:/, 'https:'),
      source: 'Google Books',
      title: [v.title, v.publishedDate?.slice(0, 4)].filter(Boolean).join(' · '),
    });
  }
  return out;
}

/** Open Library — different scans of the same titles, so it fills real gaps. */
async function fromOpenLibrary(query) {
  const data = await getJSON(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}` +
      `&limit=12&fields=title,first_publish_year,cover_i,isbn`
  );

  const out = [];
  for (const doc of data?.docs || []) {
    let url = null;
    if (doc.cover_i) {
      url = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
    } else {
      const isbn = (doc.isbn || []).map(normalizeIsbn).find(Boolean);
      if (isbn) url = coverFromIsbn(isbn);
    }
    if (!url) continue;

    out.push({
      url,
      thumbnail: url.replace('-L.jpg', '-M.jpg'),
      source: 'Open Library',
      title: [doc.title, doc.first_publish_year].filter(Boolean).join(' · '),
    });
  }
  return out;
}

/**
 * Search both catalogs and merge. Google Books goes first — its art is the more
 * reliably present — and duplicates by URL are dropped.
 */
export async function searchImages(query, { kind = 'book' } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Enter something to search for.');

  if (kind === 'boardgame') {
    // BGG is the only catalog with box art. Without a token there's nothing to
    // query, and the UI offers the paste field instead.
    if (!bgg.isConfigured()) return [];
    return bgg.findCovers(q);
  }

  const [google, openlib] = await Promise.all([
    fromGoogleBooks(q).catch(() => []),
    fromOpenLibrary(q).catch(() => []),
  ]);

  const seen = new Set();
  const merged = [];
  for (const r of [...google, ...openlib]) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    merged.push(r);
  }
  return merged.slice(0, 24);
}

/**
 * Verify a pasted URL points at a real image before the caller commits to it.
 * Open Library in particular answers with a blank placeholder rather than a 404.
 */
export async function looksLikeImage(url) {
  return coverExists(url);
}
