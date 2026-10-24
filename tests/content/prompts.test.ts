import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PromptLibrary, parsePromptLibrary, baseLanguage } from '../../src/schema/prompts';
import { parseWorld } from '../../src/schema/refs';

const root = join(__dirname, '..', '..');
const raw = JSON.parse(readFileSync(join(root, 'content', 'prompts.json'), 'utf8'));
const lib = PromptLibrary.parse(raw);
const worldsDir = join(root, 'content', 'worlds');

describe('content/prompts.json (DESIGN §9, DoD #9)', () => {
  it('parses strictly (no invalid entries)', () => {
    expect(parsePromptLibrary(raw).errors).toEqual([]);
  });

  it('has at least 25 prompts over at least 10 genres', () => {
    expect(lib.prompts.length).toBeGreaterThanOrEqual(25);
    const genres = new Set(lib.prompts.map((p) => p.genre.toLowerCase()));
    expect(genres.size).toBeGreaterThanOrEqual(10);
  });

  it('keeps fantasy / dungeon prompts to a minority', () => {
    const fantasy = lib.prompts.filter((p) => /fantasy|dungeon/i.test(p.genre));
    expect(fantasy.length).toBeLessThanOrEqual(Math.ceil(lib.prompts.length * 0.15));
  });

  it('includes non-violent prompts and Norwegian prompts', () => {
    expect(lib.prompts.filter((p) => p.nonViolent).length).toBeGreaterThanOrEqual(2);
    expect(lib.prompts.filter((p) => baseLanguage(p.language) === 'nb').length).toBeGreaterThanOrEqual(2);
  });

  const recorded = lib.prompts.filter((p) => p.worldId);
  it('at least 10 prompts come with a recorded world', () => {
    expect(recorded.length).toBeGreaterThanOrEqual(10);
  });

  for (const p of recorded) {
    it(`${p.id}: its world ${p.worldId} exists, validates and matches language / violence`, () => {
      const file = join(worldsDir, `${p.worldId}.json`);
      expect(existsSync(file)).toBe(true);
      const r = parseWorld(JSON.parse(readFileSync(file, 'utf8')));
      expect(r.ok, r.ok ? '' : r.errors.slice(0, 5).join('\n')).toBe(true);
      if (!r.ok) return;
      expect(baseLanguage(r.world.meta.language)).toBe(baseLanguage(p.language));
      expect(r.world.meta.nonViolent).toBe(p.nonViolent);
    });
  }

  it('every recorded non-fixture world has a library entry', () => {
    const ids = new Set(recorded.map((p) => p.worldId));
    const worlds = readdirSync(worldsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    expect(worlds.filter((w) => !ids.has(w))).toEqual([]);
  });

  it('drops a bad entry but keeps the rest', () => {
    const broken = { version: 1, prompts: [lib.prompts[0], { id: 'Bad Id', prompt: 'x' }, lib.prompts[0]] };
    const r = parsePromptLibrary(broken);
    expect(r.prompts).toHaveLength(1);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[1]).toContain('duplicate');
    expect(parsePromptLibrary(null).errors[0]).toContain('not a prompt library');
  });

  it('baseLanguage', () => {
    expect(baseLanguage('nb-NO')).toBe('nb');
    expect(baseLanguage(undefined)).toBe('en');
  });
});
