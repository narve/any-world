/** The prompt library in the UI language (src/client/i18n/library.ts). */
import { describe, expect, it } from 'vitest';
import { localizePrompt, localizePromptLibrary, translatedWorlds } from '../../src/client/i18n/library';
import { promptLibrary } from '../../src/client/prompts';
import type { PromptEntry } from '../../src/schema/prompts';

const base = { genre: 'saga', tags: ['x'], nonViolent: true };
const viking: PromptEntry = {
  ...base,
  id: 'viking',
  prompt: 'Iceland, 1004. Recite the law from memory.',
  language: 'en',
  teaser: 'Recite the law.',
  worldId: 'viking',
  translations: { nb: { prompt: 'Island, 1004. Si fram loven etter hukommelsen.', teaser: 'Si fram loven.', genre: 'vikingsaga', worldId: 'viking-nb' } },
};
const vikingNb: PromptEntry = { ...base, id: 'viking-nb', prompt: 'Island, 1004. Si fram loven etter hukommelsen.', language: 'nb', teaser: 'Si fram loven.', worldId: 'viking-nb', translationOf: 'viking' };
const troll: PromptEntry = { ...base, id: 'troll', prompt: 'Trollene under Dovre har fått et direktorat.', language: 'nb', teaser: 'Byråkrati under fjellet.', worldId: 'troll' };
const plain: PromptEntry = { ...base, id: 'plain', prompt: 'An English prompt with no translation.', language: 'en', teaser: 'Only English.' };

describe('localizePrompt', () => {
  it('uses the translation, its genre and its translated world', () => {
    const nb = localizePrompt(viking, 'nb-NO');
    expect(nb).toMatchObject({ id: 'viking', language: 'nb', prompt: viking.translations!.nb!.prompt, teaser: 'Si fram loven.', genre: 'vikingsaga', worldId: 'viking-nb' });
  });
  it('leaves entries alone that are already in the language or have no translation', () => {
    expect(localizePrompt(viking, 'en')).toBe(viking);
    expect(localizePrompt(troll, 'nb')).toBe(troll);
    expect(localizePrompt(plain, 'nb')).toBe(plain);
  });
  it('keeps the original world when the translation has none', () => {
    const e = { ...viking, translations: { nb: { prompt: 'Island, 1004. Si fram loven etter hukommelsen.', teaser: 'Si fram loven.' } } };
    expect(localizePrompt(e, 'nb')).toMatchObject({ worldId: 'viking', genre: 'saga', language: 'nb' });
  });
});

describe('localizePromptLibrary', () => {
  const lib = [viking, troll, vikingNb, plain];
  it('nb: one entry per translation group, in Norwegian', () => {
    const out = localizePromptLibrary(lib, 'nb');
    expect(out.map((e) => e.id)).toEqual(['viking', 'troll', 'plain']);
    expect(out[0]).toMatchObject({ language: 'nb', worldId: 'viking-nb' });
    expect(out[2]!.language).toBe('en');
  });
  it('en: the original, never its copy beside it', () => {
    const out = localizePromptLibrary(lib, 'en');
    expect(out.map((e) => e.id)).toEqual(['viking', 'troll', 'plain']);
    expect(out[0]).toBe(viking);
  });
  it('a copy whose original is missing stays on its own', () => {
    expect(localizePromptLibrary([vikingNb], 'en').map((e) => e.id)).toEqual(['viking-nb']);
  });
  it('translatedWorlds maps copies to their originals', () => {
    expect([...translatedWorlds(lib)]).toEqual([['viking-nb', { of: 'viking', language: 'nb' }]]);
  });
});

describe('the real library', () => {
  it('reads entirely in Norwegian for an nb UI, and links both translated worlds', () => {
    const out = localizePromptLibrary(promptLibrary(), 'nb');
    expect(out.filter((e) => e.language !== 'nb').map((e) => e.id)).toEqual([]);
    const worlds = new Set(out.map((e) => e.worldId));
    expect(worlds.has('viking-lawspeaker-althing-nb')).toBe(true);
    expect(worlds.has('corporate-merger-kitchen-nb')).toBe(true);
    expect(worlds.has('viking-lawspeaker-althing')).toBe(false);
    expect(new Set(out.map((e) => e.id)).size).toBe(out.length);
  });
  it('an en UI keeps one card per world', () => {
    const out = localizePromptLibrary(promptLibrary(), 'en');
    expect(out.some((e) => e.id === 'viking-lawspeaker-althing-nb')).toBe(false);
    expect(out.some((e) => e.id === 'viking-lawspeaker-althing')).toBe(true);
  });
});

describe('tag labels', () => {
  it('every library tag has a bokmål label', async () => {
    const { tagLabel, labelledTags } = await import('../../src/client/i18n/tags');
    const tags = new Set(promptLibrary().flatMap((e) => e.tags));
    const have = new Set(labelledTags('nb'));
    expect([...tags].filter((t) => !have.has(t))).toEqual([]);
    expect(tagLabel('investigation', 'nb-NO')).toBe('etterforskning');
    expect(tagLabel('investigation', 'en')).toBe('investigation');
    expect(tagLabel('brand-new-tag', 'nb')).toBe('brand-new-tag');
  });
});
