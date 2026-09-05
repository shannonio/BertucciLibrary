/**
 * Reading the ingredients off a recipe card.
 *
 * The cards are photographs. Everything a recipe actually says — what is in it,
 * how much, in what order — exists only as pixels, which is why the planner
 * could show you a card all year and still not know it needed flour. The
 * printed shopping list needs that text, so this is where the picture becomes
 * a list.
 *
 * Claude reads the card. There is no OCR library here and no parsing of the
 * result: the model is asked for the ingredient lines exactly as printed and
 * hands back an array of strings, which is the same shape a person typing into
 * the edit dialog produces. A card whose ingredients were read and one whose
 * ingredients were typed are indistinguishable afterwards, on purpose — the
 * extraction is a convenience, not a separate kind of data.
 *
 * Everything here is best-effort. An unreadable card, a missing API key, a
 * model that declines: all of them mean the card saves with no ingredients and
 * the person is told so. Nothing about uploading a card depends on this
 * working.
 */
import fs from 'fs';
import path from 'path';
import { getClient, MODEL } from './claude.js';

const MEDIA_TYPE_FOR_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Claude reads images, not every format a phone can produce. HEIC in
// particular arrives from an iPad and is not something the API accepts, so it
// is refused here with a reason rather than sent and rejected.
export function mediaTypeFor(filePath) {
  return MEDIA_TYPE_FOR_EXT[path.extname(filePath).toLowerCase()] || null;
}

const SCHEMA = {
  type: 'object',
  properties: {
    ingredients: {
      type: 'array',
      description:
        'Every ingredient line on the card, in the order printed, each exactly as written.',
      items: { type: 'string' },
    },
    readable: {
      type: 'boolean',
      description: 'False if this is not a recipe card, or the ingredients cannot be read.',
    },
  },
  required: ['ingredients', 'readable'],
  additionalProperties: false,
};

const PROMPT = [
  'This is a photograph of a recipe card. Transcribe its ingredient list.',
  '',
  'Give every ingredient line exactly as printed, including the quantity and any',
  'note that is part of the line — "2 cups all-purpose flour", "1/2 tsp sea salt",',
  '"4 tbsp unsalted butter, softened". Keep the order they appear in.',
  '',
  'A card often splits its ingredients into sections — a dough and a filling, a',
  'sauce and a topping. List the lines from every section. Do not include the',
  'section headings themselves, and do not include anything from the',
  'instructions, the notes, the equipment list, or the nutrition panel.',
  '',
  'Do not convert units, round quantities, correct spelling, or tidy the wording.',
  'The line is going onto a shopping list and needs to read the way the card',
  'reads. If a quantity is genuinely illegible, give the ingredient without it',
  'rather than guessing a number.',
  '',
  'If the image is not a recipe card, or the ingredients cannot be made out at',
  'all, set readable to false and return an empty list. Never invent an',
  'ingredient that is not printed on the card.',
].join('\n');

const MAX_LINES = 80;
const MAX_LINE = 200;

/**
 * Read the ingredients off one card image.
 *
 * Throws only for a caller mistake — no key, an image type the API will not
 * take. A model that reads nothing useful returns an empty array, which the
 * caller stores as "none recorded" rather than treating as a failure.
 */
export async function readIngredients({ base64, mediaType }) {
  const anthropic = getClient();
  if (!anthropic) throw new Error('Claude is not configured (no ANTHROPIC_API_KEY).');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: {
      // A recipe card is small, dense and unambiguous; the work is careful
      // reading rather than reasoning, and medium gets the quantities right
      // without spending Opus on a picture of a muffin.
      effort: 'medium',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to read that image.');
  }

  const text = response.content.find((b) => b.type === 'text')?.text || '{}';
  const parsed = JSON.parse(text);
  if (!parsed.readable || !Array.isArray(parsed.ingredients)) return [];

  return parsed.ingredients
    .map((line) => String(line).replace(/\s+/g, ' ').trim().slice(0, MAX_LINE))
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

/** The same, for a card image already on disk. */
export async function readIngredientsFromFile(filePath) {
  const mediaType = mediaTypeFor(filePath);
  if (!mediaType) throw new Error(`Cannot read ingredients from a ${path.extname(filePath)} file.`);
  const base64 = fs.readFileSync(filePath).toString('base64');
  return readIngredients({ base64, mediaType });
}
