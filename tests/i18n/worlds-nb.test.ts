/**
 * Translated demo worlds (DESIGN §7b "demo worlds may get translated copies"): each <id>-nb.json is
 * the same world as <id>.json — same ids, numbers, enums, maps and rules — with every
 * player-facing text in Norwegian bokmål.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorld } from '../../src/schema/refs';
import { PromptLibrary } from '../../src/schema/prompts';

const ROOT = join(__dirname, '../..');
const read = (id: string): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, 'content/worlds', `${id}.json`), 'utf8'));

const PAIRS = ['viking-lawspeaker-althing', 'corporate-merger-kitchen'];

/** names that are the same in both languages on purpose (proper nouns, loanwords) */
const SAME_OK = new Set(['saga', 'satire', 'Argument', 'Pip Okonedo-Marsh']);

/** fields whose string values are player-facing text (everything else must be identical) */
const TEXT_KEYS = new Set([
  'name', 'description', 'lines', 'verb', 'abbr', 'label', 'text', 'personality', 'greeting', 'secrets', 'wants', 'threads',
  'transitionName', 'gmNotes', 'areaEnter', 'events', 'lowHp', 'title', 'suggestions', 'tagline', 'genre', 'tone', 'era',
  'premise', 'prompt', 'conflict', 'defeated', 'xp', 'levelUp', 'currency', 'lossTitle', 'winTitle', 'area', 'summary',
  'winText', 'lossText', 'persona', 'voice', 'intro', 'mood', 'vagueText',
]);

interface Leaf {
  path: string;
  value: unknown;
  text: boolean;
}

function leaves(x: unknown, path: (string | number)[] = [], out: Leaf[] = []): Leaf[] {
  if (Array.isArray(x)) x.forEach((v, i) => leaves(v, [...path, i], out));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) leaves(v, [...path, k], out);
  else {
    const key = [...path].reverse().find((p) => typeof p === 'string') as string | undefined;
    const isColour = typeof x === 'string' && /^#[0-9a-f]{3,6}$/i.test(x);
    const text =
      typeof x === 'string' &&
      !isColour &&
      (TEXT_KEYS.has(key ?? '') || (path[0] === 'meta' && path[1] === 'tags') || (path[0] === 'goal' && path[1] === 'labels') || (path[0] === 'items' && path[2] === 'kind')) &&
      path.join('/') !== 'meta/language';
    out.push({ path: path.join('/'), value: x, text });
  }
  return out;
}

describe.each(PAIRS)('%s-nb', (id) => {
  const en = read(id);
  const nb = read(`${id}-nb`);

  it('validates and is written in Norwegian bokmål', () => {
    const r = parseWorld(nb);
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (r.ok) expect(r.world.meta.language).toBe('nb');
  });

  it('is the same world: identical structure, ids, numbers and machine fields', () => {
    const a = leaves(en);
    const b = leaves(nb);
    expect(b.map((l) => l.path)).toEqual(a.map((l) => l.path));
    const diffs = a.filter((l, i) => !l.text && l.path !== 'meta/language' && l.value !== b[i]!.value).map((l) => l.path);
    expect(diffs).toEqual([]);
  });

  it('translates every player-facing text', () => {
    const a = leaves(en);
    const b = leaves(nb);
    const untranslated = a.filter((l, i) => l.text && l.value === b[i]!.value && !SAME_OK.has(String(l.value))).map((l) => `${l.path}: ${l.value}`);
    expect(untranslated).toEqual([]);
    // and reads as Norwegian: common English function words do not appear in long texts
    const english = /\b(the|and|you|your|with|of|is|are|it|The|You)\b/;
    const leaks = b.filter((l) => l.text && typeof l.value === 'string' && l.value.length > 30 && english.test(l.value.replace(/Halberd & Pike|Pax tibi/g, ''))).map((l) => `${l.path}: ${l.value}`);
    expect(leaks).toEqual([]);
  });
});

describe('prompt library links the translated worlds', () => {
  const lib = PromptLibrary.parse(JSON.parse(readFileSync(join(ROOT, 'content/prompts.json'), 'utf8')));
  it.each(PAIRS)('%s has nb text pointing at its -nb world, and the -nb world its own entry', (id) => {
    const src = lib.prompts.find((p) => p.worldId === id)!;
    expect(src.translations?.nb?.worldId).toBe(`${id}-nb`);
    const copy = lib.prompts.find((p) => p.worldId === `${id}-nb`)!;
    expect(copy.language).toBe('nb');
    expect(copy.translationOf).toBe(src.id);
    expect(copy.prompt).toBe(src.translations!.nb!.prompt);
    expect((read(`${id}-nb`).meta as { prompt: string }).prompt).toBe(copy.prompt);
  });

  it('every English entry has Norwegian prompt and teaser text', () => {
    const missing = lib.prompts.filter((p) => p.language === 'en' && !p.translations?.nb).map((p) => p.id);
    expect(missing).toEqual([]);
    for (const p of lib.prompts.filter((x) => x.translations?.nb)) {
      expect(p.translations!.nb!.prompt).not.toBe(p.prompt);
      expect(p.translations!.nb!.teaser).not.toBe(p.teaser);
      expect(/\b(the|and|you|your)\b/i.test(p.translations!.nb!.prompt), p.id).toBe(false);
    }
  });
});
