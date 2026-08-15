import Anthropic from '@anthropic-ai/sdk';
import { searchItems, stats, db } from './db.js';

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';

let client = null;
export function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

export function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// ---------------------------------------------------------------- Tools
//
// Claude answers by querying the catalog rather than being handed all 968+
// rows up front. That keeps answers grounded in real inventory, keeps cost
// flat as the catalog grows, and means digital curriculum and board games
// are searchable the moment they're added.

const TOOLS = [
  {
    name: 'search_catalog',
    description:
      "Full-text search of Shannon's home library and homeschool catalog. " +
      'Searches titles, authors, genres, subjects, summaries, tags, and notes. ' +
      'Use this whenever the question depends on what is actually on the shelves — ' +
      'building a lesson, finding books on a topic, checking whether something is owned. ' +
      'Call it several times with different wording to cover a topic well: a search for ' +
      '"weather" and a search for "clouds rain storms" will surface different items. ' +
      'Returns matching items with their titles, authors, subjects, summaries, and ISBNs.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keywords to search for. Prefer topical keywords over full sentences.',
        },
        kind: {
          type: 'string',
          enum: ['book', 'boardgame', 'curriculum', 'material', 'media'],
          description: 'Optional: restrict to one type of item.',
        },
        limit: {
          type: 'integer',
          description: 'Max results to return (default 25, max 60).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'browse_catalog',
    description:
      'List items without a keyword search — filter by kind and/or genre. Use this ' +
      'for questions like "what board games do we have" or "list our Waldorf curriculum" ' +
      'where there is no specific topic to search for.',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['book', 'boardgame', 'curriculum', 'material', 'media'],
        },
        genre: { type: 'string', description: 'Partial genre match, e.g. "Poetry".' },
        limit: { type: 'integer', description: 'Max results (default 40, max 100).' },
      },
    },
  },
  {
    name: 'catalog_overview',
    description:
      'Get high-level statistics about the catalog: total item count, a breakdown by ' +
      'kind, and the most common genres. Use this to orient yourself before answering ' +
      'broad questions about the collection as a whole.',
    input_schema: { type: 'object', properties: {} },
  },
];

function compactItem(it) {
  const out = {
    id: it.id,
    kind: it.kind,
    title: it.title,
  };
  if (it.creator) out.author = it.creator;
  if (it.genre) out.genre = it.genre;
  if (it.subject) out.subject = it.subject;
  if (it.isbn) out.isbn = it.isbn;
  if (it.age_range) out.age_range = it.age_range;
  if (it.players) out.players = it.players;
  if (it.play_time) out.play_time = it.play_time;
  if (it.tags) out.tags = it.tags;
  if (it.location) out.location = it.location;
  // Digital curriculum: where the file sits and how to open it, so lesson plans
  // can point at actual files rather than just naming them.
  if (it.file_path) out.file_path = it.file_path;
  if (it.web_url) out.link = it.web_url;
  // Summaries dominate the token budget; a lead fragment is enough for Claude
  // to judge relevance, and it can always search again for more.
  if (it.summary) out.summary = it.summary.slice(0, 320);
  return out;
}

function runTool(name, input) {
  if (name === 'search_catalog') {
    const { rows, total } = searchItems({
      q: input.query,
      kind: input.kind,
      limit: Math.min(input.limit || 25, 60),
    });
    return {
      query: input.query,
      total_matches: total,
      returned: rows.length,
      items: rows.map(compactItem),
    };
  }

  if (name === 'browse_catalog') {
    const { rows, total } = searchItems({
      kind: input.kind,
      genre: input.genre,
      limit: Math.min(input.limit || 40, 100),
    });
    return {
      total_matches: total,
      returned: rows.length,
      items: rows.map(compactItem),
    };
  }

  if (name === 'catalog_overview') {
    const s = stats();
    return {
      total_items: s.total,
      by_kind: s.byKind,
      items_with_covers: s.withCovers,
      items_with_isbn: s.withIsbn,
      top_genres: s.topGenres,
    };
  }

  return { error: `Unknown tool: ${name}` };
}

const SYSTEM_PROMPT = `You are the librarian for a homeschooling family's personal collection. You have tools to search their actual catalog — books, board games, curriculum, craft materials, and digital resources.

Ground every answer in what the tools return. Search before answering any question that depends on what they own; don't answer from memory about which books exist in this house. If a search comes back empty, say plainly that you don't see it in the catalog rather than guessing.

Search more than once when a topic has several natural phrasings — "weather" and "clouds rain storms" surface different shelves. A thorough answer is worth two or three searches.

When you recommend items, name the exact title and author as they appear in the catalog so they can be found on the shelf. Mention an item's ID only if asked.

Lesson planning is the main use for this catalog. When asked to build a lesson or unit, work with what they actually have: group the real items you found into a sensible sequence, note the age range each suits, and say directly if there's a gap the collection doesn't cover.

The collection includes digital files from their Drive as well as physical books and games. Those carry the folder they live in and a link to open them — mention the folder when it helps them find the file, and treat printable worksheets and lesson plans as usable material alongside the books.

Keep responses tight and readable on a phone. Prose and short lists, not tables. Lead with the answer, then the supporting detail.`;

/**
 * Run the agentic loop, streaming plain-text events back to the caller.
 * `onEvent` receives {type:'status'|'text'|'done'|'error', ...}.
 */
export async function ask({ messages, onEvent, signal }) {
  const anthropic = getClient();
  if (!anthropic) {
    onEvent({
      type: 'error',
      error:
        'Claude is not configured. Add ANTHROPIC_API_KEY to your .env file and restart the server.',
    });
    return;
  }

  const convo = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const MAX_TURNS = 8;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = anthropic.messages.stream(
        {
          model: MODEL,
          // Thinking and the reply share this budget, and a unit plan drawing
          // on a dozen books is a long answer. Streaming makes the large
          // ceiling free of timeout risk.
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          thinking: { type: 'adaptive' },
          // Lesson planning is the load-bearing use case here and volume is
          // low, so favour answer quality over latency.
          output_config: { effort: 'high' },
          tools: TOOLS,
          messages: convo,
        },
        { signal }
      );

      stream.on('text', (delta) => onEvent({ type: 'text', text: delta }));

      const response = await stream.finalMessage();

      if (response.stop_reason === 'refusal') {
        onEvent({
          type: 'error',
          error: 'Claude declined to answer that request.',
        });
        return;
      }

      const toolUses = response.content.filter((b) => b.type === 'tool_use');

      if (!toolUses.length) {
        onEvent({ type: 'done' });
        return;
      }

      convo.push({ role: 'assistant', content: response.content });

      const results = [];
      for (const tu of toolUses) {
        onEvent({
          type: 'status',
          status:
            tu.name === 'search_catalog'
              ? `Searching the catalog for “${tu.input.query}”…`
              : tu.name === 'browse_catalog'
                ? 'Browsing the catalog…'
                : 'Checking catalog totals…',
        });
        let payload;
        try {
          payload = runTool(tu.name, tu.input || {});
        } catch (err) {
          payload = { error: String(err.message || err) };
        }
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(payload),
        });
      }

      convo.push({ role: 'user', content: results });
    }

    onEvent({
      type: 'error',
      error: 'That took too many steps to answer. Try a narrower question.',
    });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    onEvent({ type: 'error', error: describeError(err) });
  }
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Your ANTHROPIC_API_KEY was rejected. Check the key in .env.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Rate limited by the Claude API. Wait a moment and try again.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Claude API. Check your internet connection.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Claude API error (${err.status}): ${err.message}`;
  }
  return String(err?.message || err);
}

// ---------------------------------------------------------------- Vision scan

const SHELF_SCHEMA = {
  type: 'object',
  properties: {
    books: {
      type: 'array',
      description: 'One entry per distinct book visible in the image.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title exactly as printed.' },
          author: {
            type: 'string',
            description: 'Author as printed, or an empty string if not visible.',
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description:
              'high = text is fully legible; low = partially obscured or a guess.',
          },
        },
        required: ['title', 'author', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['books'],
  additionalProperties: false,
};

/**
 * Read book titles off a photo of covers or spines. Returns raw titles only —
 * ISBN/cover resolution happens afterwards through the normal lookup path, and
 * nothing is written to the catalog until the user confirms.
 */
export async function scanShelfImage({ base64, mediaType }) {
  const anthropic = getClient();
  if (!anthropic) throw new Error('Claude is not configured (no ANTHROPIC_API_KEY).');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: SHELF_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text:
              'This is a photo of books — covers face-out, spines on a shelf, or a stack. ' +
              'List every distinct book you can identify. Read the title and author exactly as ' +
              'printed; do not correct, expand, or translate them. Include a book even when you ' +
              'are only partly sure, and mark it low confidence — the result will be reviewed ' +
              'before anything is saved. Do not invent books that are not visible, and list each ' +
              'physical book once even if several copies appear.',
          },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to process that image.');
  }

  const text = response.content.find((b) => b.type === 'text')?.text || '{}';
  const parsed = JSON.parse(text);
  return parsed.books || [];
}
