/**
 * BoardGameGeek XML API v2.
 *
 * BGG now requires registration and a bearer token for API access (open to
 * everyone, commercial or not). Register at boardgamegeek.com/using_the_xml_api,
 * then put the application token in .env as BGG_TOKEN.
 *
 * This is the only source that actually has board game box art, so it fills the
 * one real gap in the catalog — and it carries designers and player counts too.
 */

const BASE = 'https://boardgamegeek.com/xmlapi2';
const UA = 'BertucciLibrary/0.1 (personal home game catalog)';

export function isConfigured() {
  return Boolean(process.env.BGG_TOKEN);
}

export function configProblem() {
  if (!process.env.BGG_TOKEN) {
    return (
      'BGG_TOKEN is not set. Register for XML API access at ' +
      'boardgamegeek.com/using_the_xml_api, then add the application token to .env ' +
      'as BGG_TOKEN.'
    );
  }
  return null;
}

async function getXML(path, { timeout = 15000, attempts = 3 } = {}) {
  if (!isConfigured()) throw new Error(configProblem());

  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${process.env.BGG_TOKEN}`,
          'User-Agent': UA,
          Accept: 'application/xml',
        },
        signal: ctrl.signal,
      });

      if (res.status === 401 || res.status === 403) {
        throw new Error(
          'BGG rejected the token. Check BGG_TOKEN in .env matches the application ' +
            'token from boardgamegeek.com/using_the_xml_api.'
        );
      }
      // BGG answers 202 while it builds a result, and throttles bursts with 429.
      // Both mean "ask again shortly" rather than "no".
      if (res.status === 202 || res.status === 429) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`BGG returned ${res.status}`);
      return await res.text();
    } catch (err) {
      if (err.name === 'AbortError' && attempt < attempts - 1) continue;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// BGG's XML is machine-generated and consistent, so targeted extraction is
// enough here and avoids pulling in an XML parser dependency.
const attr = (xml, tag, name = 'value') => {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`, 'i'));
  return m ? decode(m[1]) : null;
};
const text = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decode(m[1].trim()) : null;
};
const decode = (s) =>
  String(s)
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&amp;/g, '&');

/** Split `<item …>…</item>` blocks without needing a real parser. */
function itemBlocks(xml) {
  return [...String(xml || '').matchAll(/<item\b[^>]*>[\s\S]*?<\/item>|<item\b[^>]*\/>/gi)].map(
    (m) => m[0]
  );
}

/** Search BGG for games matching a title. */
export async function search(query, { limit = 8 } = {}) {
  const xml = await getXML(
    `/search?query=${encodeURIComponent(query)}&type=boardgame,boardgameexpansion`
  );
  if (!xml) return [];

  return itemBlocks(xml)
    .map((block) => ({
      id: block.match(/\bid="(\d+)"/)?.[1] || null,
      name: attr(block, 'name'),
      year: attr(block, 'yearpublished'),
    }))
    .filter((r) => r.id && r.name)
    .slice(0, limit);
}

/** Full detail for one game, including box art. */
export async function thing(id) {
  const xml = await getXML(`/thing?id=${encodeURIComponent(id)}&stats=0`);
  if (!xml) return null;

  const block = itemBlocks(xml)[0];
  if (!block) return null;

  const designers = [...block.matchAll(/<link\b[^>]*type="boardgamedesigner"[^>]*value="([^"]*)"/gi)]
    .map((m) => decode(m[1]));
  const publishers = [...block.matchAll(/<link\b[^>]*type="boardgamepublisher"[^>]*value="([^"]*)"/gi)]
    .map((m) => decode(m[1]));
  const categories = [...block.matchAll(/<link\b[^>]*type="boardgamecategory"[^>]*value="([^"]*)"/gi)]
    .map((m) => decode(m[1]));

  const min = attr(block, 'minplayers');
  const max = attr(block, 'maxplayers');
  const playing = attr(block, 'playingtime');
  const minTime = attr(block, 'minplaytime');
  const maxTime = attr(block, 'maxplaytime');

  return {
    bggId: id,
    // The primary name is the English/canonical one.
    title:
      block.match(/<name\b[^>]*type="primary"[^>]*value="([^"]*)"/i)?.[1]
        ? decode(block.match(/<name\b[^>]*type="primary"[^>]*value="([^"]*)"/i)[1])
        : attr(block, 'name'),
    image: text(block, 'image'),
    thumbnail: text(block, 'thumbnail'),
    designers,
    publisher: publishers[0] || null,
    categories,
    published: attr(block, 'yearpublished'),
    players: min && max ? (min === max ? min : `${min}-${max}`) : min || max || null,
    play_time:
      minTime && maxTime && minTime !== maxTime
        ? `${minTime}-${maxTime} min`
        : playing
          ? `${playing} min`
          : null,
    age: attr(block, 'minage') ? `${attr(block, 'minage')}+` : null,
    summary: text(block, 'description')?.replace(/\s+/g, ' ').slice(0, 1200) || null,
  };
}

/**
 * Find cover art for a game by title. Returns several candidates so the picker
 * can show alternatives — BGG has separate entries for editions and expansions,
 * and the top hit isn't always the copy on the shelf.
 */
export async function findCovers(title, { limit = 6 } = {}) {
  const hits = await search(title, { limit });
  const out = [];

  for (const hit of hits) {
    const detail = await thing(hit.id).catch(() => null);
    if (!detail?.image) continue;
    out.push({
      url: detail.image,
      thumbnail: detail.thumbnail || detail.image,
      source: 'BoardGameGeek',
      title: [detail.title, detail.published].filter(Boolean).join(' · '),
      meta: detail,
    });
    // Courtesy pacing — BGG asks clients not to hammer the API.
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}
