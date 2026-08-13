/**
 * Book metadata lookup against Open Library and Google Books.
 *
 * Both are free and keyless. Open Library is the primary source because its
 * cover CDN is stable and unmetered; Google Books fills in the gaps (it has
 * better coverage of recent and self-published titles).
 */

const UA = 'BertucciLibrary/0.1 (personal home library catalog)';

/**
 * Providers fail softly here — a miss just means "no metadata". But a
 * quota/rate-limit rejection is different: it looks identical to "not found"
 * while silently degrading every lookup. Record those so callers can tell the
 * user why a run came back empty instead of leaving them to guess.
 */
const providerIssues = new Map();

export function getProviderIssues() {
  return [...providerIssues.values()];
}

export function clearProviderIssues() {
  providerIssues.clear();
}

function noteIssue(url, status, exhausted) {
  if (status !== 429 && status !== 403) return;
  const isGoogle = url.includes('googleapis.com');
  const provider = isGoogle ? 'Google Books' : 'Open Library';

  let hint;
  if (!exhausted) {
    // Retries absorbed it — worth knowing, but nothing to act on.
    hint = 'Throttled briefly; the request succeeded after a retry.';
  } else if (isGoogle && process.env.GOOGLE_BOOKS_API_KEY) {
    hint =
      'Still throttled after retries. If this run covered a lot of items you may have ' +
      "hit the 1,000/day project quota, which resets on Google's clock (midnight Pacific). " +
      'Otherwise just re-run — the remaining items will resolve.';
  } else if (isGoogle) {
    hint =
      'Daily quota for keyless requests is exhausted. Add a free key to .env as ' +
      'GOOGLE_BOOKS_API_KEY to raise the limit, or re-run tomorrow.';
  } else {
    hint = 'Rate limited after retries. Wait a few minutes and re-run.';
  }
  providerIssues.set(provider, `${provider}: ${hint}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Both providers throttle bursts. A 429 is transient, not a "no such book",
 * so back off and retry rather than reporting the item as unresolvable —
 * otherwise a fast run silently loses lookups that would have succeeded.
 */
async function getJSON(url, { timeout = 12000, attempts = 3 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ctrl.signal,
      });

      if (res.status === 429 || res.status === 403) {
        const last = attempt === attempts - 1;
        noteIssue(url, res.status, last);
        if (last) return null;
        // Honour Retry-After when offered, else exponential backoff + jitter.
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : 800 * 2 ** attempt + Math.random() * 400;
        await sleep(Math.min(backoff, 8000));
        continue;
      }

      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export function normalizeIsbn(raw) {
  const s = String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (s.length === 10 || s.length === 13) return s;
  return null;
}

/** ISBN-10 -> ISBN-13 so everything in the DB is stored consistently. */
export function isbn10to13(isbn10) {
  const s = normalizeIsbn(isbn10);
  if (!s || s.length !== 10) return null;
  const core = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + String((10 - (sum % 10)) % 10);
}

export function coverFromIsbn(isbn, size = 'L') {
  const s = normalizeIsbn(isbn);
  return s ? `https://covers.openlibrary.org/b/isbn/${s}-${size}.jpg` : null;
}

function cleanTitle(title) {
  // Strip series prefixes and parenthetical publisher notes that hurt matching:
  // "National Geographic Kids Readers: Mars" -> also try "Mars"
  return String(title || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

function primaryAuthor(creator) {
  // "Kate Narita (illustrated by Suzanne Kaufman)" -> "Kate Narita"
  return String(creator || '')
    .replace(/\s*\([^)]*\)/g, '')
    .split(/\s*(?:,|;|\band\b|&)\s*/i)[0]
    .trim();
}

function normalizeForCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Loose title match — guards against Open Library returning a wrong book. */
function titlesAgree(a, b) {
  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// ---------------------------------------------------------------- Open Library

// Words that stay lowercase inside a title, per standard title case.
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'nor', 'of',
  'on', 'or', 'the', 'to', 'up', 'vs', 'via', 'with',
]);

/**
 * Open Library stores many titles sentence-cased ("my year in the middle").
 * Restore title case, but only when the record clearly lost its casing —
 * a title that already contains interior capitals is left untouched so we
 * never mangle "The BFG", "pH Explained", or "iPad for Kids".
 */
export function fixTitleCase(title) {
  const s = String(title || '').trim();
  if (!s) return s;
  const words = s.split(/\s+/);
  if (words.length < 2) return s;
  if (/[A-Z]/.test(s.slice(1))) return s; // already has interior capitals

  return words
    .map((word, i) => {
      const lower = word.toLowerCase();
      const bare = lower.replace(/[^a-z]/g, '');
      const isLast = i === words.length - 1;
      if (i > 0 && !isLast && MINOR_WORDS.has(bare)) return lower;
      // Capitalize past any leading punctuation, e.g. "(the" -> "(The".
      return lower.replace(/[a-z]/, (c) => c.toUpperCase());
    })
    .join(' ');
}

export async function openLibraryByIsbn(isbn) {
  const s = normalizeIsbn(isbn);
  if (!s) return null;
  const data = await getJSON(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${s}&format=json&jscmd=data`
  );
  const rec = data?.[`ISBN:${s}`];
  if (!rec) return null;

  const isbn13 = s.length === 13 ? s : isbn10to13(s);
  return {
    title: fixTitleCase(rec.title),
    creator: (rec.authors || []).map((a) => a.name).join(', ') || null,
    publisher: (rec.publishers || []).map((p) => p.name).join(', ') || null,
    published: rec.publish_date || null,
    page_count: rec.number_of_pages || null,
    subject: (rec.subjects || []).slice(0, 8).map((x) => x.name).join(', ') || null,
    isbn: isbn13,
    isbn10: s.length === 10 ? s : null,
    cover_url: rec.cover?.large || rec.cover?.medium || coverFromIsbn(s),
    _source: 'openlibrary',
  };
}

export async function openLibrarySearch(title, creator) {
  const t = cleanTitle(title);
  const a = primaryAuthor(creator);
  const params = new URLSearchParams({
    title: t,
    limit: '5',
    fields: 'title,author_name,isbn,cover_i,first_publish_year,publisher,number_of_pages_median',
  });
  if (a) params.set('author', a);

  const data = await getJSON(`https://openlibrary.org/search.json?${params}`);
  const docs = data?.docs || [];
  const hit = docs.find((d) => titlesAgree(d.title, t)) || docs[0];
  if (!hit) return null;
  if (!titlesAgree(hit.title, t)) return null;

  const isbns = (hit.isbn || []).map(normalizeIsbn).filter(Boolean);
  const isbn13 = isbns.find((x) => x.length === 13) || null;
  const isbn10 = isbns.find((x) => x.length === 10) || null;
  const resolved13 = isbn13 || (isbn10 ? isbn10to13(isbn10) : null);

  const cover = hit.cover_i
    ? `https://covers.openlibrary.org/b/id/${hit.cover_i}-L.jpg`
    : coverFromIsbn(resolved13 || isbn10);

  return {
    title: fixTitleCase(hit.title),
    creator: (hit.author_name || []).join(', ') || null,
    publisher: (hit.publisher || [])[0] || null,
    published: hit.first_publish_year ? String(hit.first_publish_year) : null,
    page_count: hit.number_of_pages_median || null,
    isbn: resolved13,
    isbn10,
    cover_url: cover,
    _source: 'openlibrary',
  };
}

// ---------------------------------------------------------------- Google Books

function fromGoogleVolume(vol, fallbackIsbn) {
  const v = vol?.volumeInfo;
  if (!v) return null;
  const ids = v.industryIdentifiers || [];
  const isbn13 = ids.find((i) => i.type === 'ISBN_13')?.identifier || null;
  const isbn10 = ids.find((i) => i.type === 'ISBN_10')?.identifier || null;
  const resolved13 = normalizeIsbn(isbn13) || (isbn10 ? isbn10to13(isbn10) : null) || normalizeIsbn(fallbackIsbn);

  // Google's thumbnails are http and zoom=1 by default; force https and a
  // larger render so covers stay sharp on a phone screen.
  let cover = v.imageLinks?.extraLarge || v.imageLinks?.large ||
              v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || null;
  if (cover) cover = cover.replace(/^http:/, 'https:').replace(/&zoom=\d/, '&zoom=2');

  return {
    title: v.title + (v.subtitle ? `: ${v.subtitle}` : ''),
    creator: (v.authors || []).join(', ') || null,
    publisher: v.publisher || null,
    published: v.publishedDate || null,
    page_count: v.pageCount || null,
    subject: (v.categories || []).join(', ') || null,
    summary: v.description || null,
    isbn: resolved13,
    isbn10: normalizeIsbn(isbn10),
    cover_url: cover || coverFromIsbn(resolved13),
    _source: 'googlebooks',
  };
}

export async function googleByIsbn(isbn) {
  const s = normalizeIsbn(isbn);
  if (!s) return null;
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  const url =
    `https://www.googleapis.com/books/v1/volumes?q=isbn:${s}` +
    (key ? `&key=${key}` : '');
  const data = await getJSON(url);
  return fromGoogleVolume(data?.items?.[0], s);
}

export async function googleSearch(title, creator) {
  const t = cleanTitle(title);
  const a = primaryAuthor(creator);
  const q = [`intitle:${JSON.stringify(t)}`, a ? `inauthor:${JSON.stringify(a)}` : '']
    .filter(Boolean)
    .join('+');
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  const url =
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5` +
    (key ? `&key=${key}` : '');
  const data = await getJSON(url);
  const items = data?.items || [];
  const hit =
    items.find((i) => titlesAgree(i.volumeInfo?.title, t)) || null;
  return hit ? fromGoogleVolume(hit) : null;
}

// ---------------------------------------------------------------- Public API

/** Look up a single ISBN across both providers, merging what each returns. */
export async function lookupByIsbn(isbn) {
  const s = normalizeIsbn(isbn);
  if (!s) return null;
  const [ol, gb] = await Promise.all([openLibraryByIsbn(s), googleByIsbn(s)]);
  if (!ol && !gb) return null;
  return mergeMeta(ol, gb, { isbn: s.length === 13 ? s : isbn10to13(s) });
}

/**
 * Catalog titles carry series prefixes and subtitles that the providers don't
 * index ("National Geographic Kids Readers: Mars", "100 Bugs!: A Counting
 * Book"). Try progressively simpler forms rather than giving up on the first
 * miss — this roughly doubles the hit rate on this catalog.
 */
function titleVariants(title) {
  const t = cleanTitle(title);
  const out = [t];
  const colon = t.indexOf(':');
  if (colon > 0) {
    out.push(t.slice(0, colon).trim());       // drop the subtitle
    out.push(t.slice(colon + 1).trim());      // drop the series prefix
  }
  const dash = t.match(/^(.+?)\s+[–—-]\s+(.+)$/);
  if (dash) out.push(dash[1].trim());
  return [...new Set(out.filter((s) => s && s.length > 2))];
}

/** Resolve a title (+ optional author) to metadata. Used for CSV enrichment. */
export async function lookupByTitle(title, creator) {
  let best = null;
  for (const variant of titleVariants(title)) {
    const ol = await openLibrarySearch(variant, creator);
    if (ol?.isbn && ol?.cover_url) return ol;

    const gb = await googleSearch(variant, creator);
    if (gb?.isbn && gb?.cover_url) return mergeMeta(ol, gb);

    if (!best && (ol || gb)) best = mergeMeta(ol, gb);
  }
  // Last resort: title alone, no author. Catches records where our author
  // string is an illustrator, a publisher imprint, or otherwise not indexed.
  if (!best) {
    const loose = await openLibrarySearch(cleanTitle(title), null);
    if (loose?.isbn || loose?.cover_url) best = loose;
  }
  return best;
}

// Open Library normalizes titles to sentence case ("My year in the middle"),
// which looks wrong on a shelf. Google Books preserves the printed casing, so
// let it win for the human-readable fields while Open Library stays primary
// for identifiers and cover art.
const PREFER_GOOGLE = new Set(['title', 'creator', 'summary']);

/** Prefer whichever provider actually has a value for each field. */
function mergeMeta(a, b, overrides = {}) {
  const out = {};
  const fields = [
    'title', 'creator', 'publisher', 'published', 'page_count',
    'subject', 'summary', 'isbn', 'isbn10', 'cover_url',
  ];
  for (const f of fields) {
    out[f] = PREFER_GOOGLE.has(f)
      ? (b?.[f] ?? a?.[f] ?? null)
      : (a?.[f] ?? b?.[f] ?? null);
  }
  if (!out.cover_url) out.cover_url = coverFromIsbn(out.isbn || out.isbn10);
  out._source = [a?._source, b?._source].filter(Boolean).join('+');
  return { ...out, ...overrides };
}

/**
 * Open Library serves a 1x1 transparent GIF for missing covers rather than a
 * 404, so a URL existing is not proof a cover does. `default=false` makes it
 * 404 properly, which is what we check here.
 */
export async function coverExists(url) {
  if (!url) return false;
  const probe = url.includes('covers.openlibrary.org')
    ? `${url}${url.includes('?') ? '&' : '?'}default=false`
    : url;
  try {
    const res = await fetch(probe, { method: 'HEAD', headers: { 'User-Agent': UA } });
    if (!res.ok) return false;
    const len = Number(res.headers.get('content-length') || '0');
    return len === 0 || len > 1000; // some CDNs omit content-length
  } catch {
    return false;
  }
}
