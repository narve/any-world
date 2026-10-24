/** Start screen: recorded worlds grouped and labelled by language; inspiration from content/prompts.json. */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { baseLang, groupByLanguage, languageEndonym, pickInspiration } from '../../src/client/ui/format';
import { inspirationPrompts, promptLibrary } from '../../src/client/prompts';
import { seededRandom } from '../../src/llm/prompts/common';

describe('language helpers', () => {
  it('baseLang', () => {
    expect(baseLang('nb-NO')).toBe('nb');
    expect(baseLang('no')).toBe('nb');
    expect(baseLang('EN_gb')).toBe('en');
    expect(baseLang(undefined)).toBe('en');
    expect(baseLang('')).toBe('en');
  });

  it('languageEndonym names a language in itself, capitalised', () => {
    expect(languageEndonym('en')).toBe('English');
    expect(languageEndonym('nb-NO').toLowerCase()).toContain('bokmål');
    expect(languageEndonym('nb')[0]).toBe('N');
    expect(languageEndonym('zz')).toBe('ZZ');
  });

  it('groupByLanguage: UI language first, order inside a group kept', () => {
    const items = [
      { id: 'a', language: 'nb' },
      { id: 'b' },
      { id: 'c', language: 'en' },
      { id: 'd', language: 'nb-NO' },
      { id: 'e', language: 'de' },
    ];
    const en = groupByLanguage(items, 'en');
    expect(en.map((g) => g.language)).toEqual(['en', 'de', 'nb']);
    expect(en[0]!.items.map((i) => i.id)).toEqual(['b', 'c']);
    expect(en[2]!.items.map((i) => i.id)).toEqual(['a', 'd']);
    expect(groupByLanguage(items, 'nb-NO')[0]!.language).toBe('nb');
  });

  it('pickInspiration prefers the UI language and fills up from the rest', () => {
    const list = [
      { p: 1, language: 'nb' },
      { p: 2, language: 'en' },
      { p: 3, language: 'en' },
      { p: 4, language: 'en' },
      { p: 5 },
    ];
    const nb = pickInspiration(list, 3, 'nb', seededRandom(3));
    expect(nb).toHaveLength(3);
    expect(nb[0]!.language).toBe('nb');
    const en = pickInspiration(list, 3, 'en', seededRandom(3));
    expect(en.every((x) => baseLang(x.language) === 'en')).toBe(true);
    expect(pickInspiration(list, 9, 'en', seededRandom(1))).toHaveLength(5);
  });
});

describe('inspiration from the prompt library', () => {
  const lib = promptLibrary();
  const worlds = new Set(readdirSync(join(__dirname, '..', '..', 'content', 'worlds')).map((f) => f.replace(/\.json$/, '')));

  it('loads every entry of content/prompts.json', () => {
    expect(lib.length).toBeGreaterThanOrEqual(25);
  });

  it('keeps worldId only for bundled worlds and carries the language', () => {
    const cards = inspirationPrompts(lib, worlds);
    expect(cards.filter((c) => c.worldId).length).toBeGreaterThanOrEqual(10);
    expect(cards.some((c) => c.language === 'nb')).toBe(true);
    const none = inspirationPrompts(lib, new Set());
    expect(none.every((c) => !c.worldId)).toBe(true);
  });

  it('every bundled world is offered as a demo in one language group', () => {
    const cards = inspirationPrompts(lib, worlds).filter((c) => c.worldId);
    const groups = groupByLanguage(cards, 'en');
    expect(groups.map((g) => g.language).sort()).toEqual(['en', 'nb']);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(cards.length);
  });
});
