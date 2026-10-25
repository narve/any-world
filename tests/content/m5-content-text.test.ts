/**
 * M5 content-text regressions for the bundled worlds:
 *   - issues/M5-area-name-prefix.md: area names must not repeat vocabulary.area or the area
 *     number ("Instans 1: 1. instans: Venterommet"), because the log, goal and strip already add
 *     "{area} {n}".
 *   - issues/M5-nb-grammar.md: Norwegian bokmål grammar slips in nb-russetid-bussen and
 *     nb-troll-direktoratet.
 *   - issues/M5-althing-nb-apprentice.md: the female player of viking-lawspeaker-althing-nb was
 *     called "Læregutt" (apprentice boy).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';

const dir = join(__dirname, '..', '..', 'content', 'worlds');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

function raw(f: string): string {
  return readFileSync(join(dir, f), 'utf8');
}

function load(f: string): WorldSpec {
  const r = parseWorld(JSON.parse(raw(f)));
  if (!r.ok) throw new Error(`${f}: ${r.errors.join('\n')}`);
  return r.world;
}

/** ordinal / weekday words a generated area name tends to be prefixed with */
const PREFIX_WORDS =
  /^(first|second|third|fourth|fifth|last|final|monday|tuesday|wednesday|thursday|friday|saturday|sunday|første|andre|tredje|fjerde|femte|siste|mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\b/i;

function areaNameProblems(world: WorldSpec): string[] {
  const out: string[] = [];
  const word = world.vocabulary.area.trim().toLowerCase();
  world.areas.forEach((a, i) => {
    const name = a.name.trim();
    const lower = name.toLowerCase();
    if (/^[^:]{1,40}:\s/.test(name)) out.push(`area ${i + 1} "${name}" has a "Prefix: " label`);
    if (word && (lower === word || lower.startsWith(`${word} `) || lower.startsWith(`${word}:`)))
      out.push(`area ${i + 1} "${name}" starts with the area word "${world.vocabulary.area}"`);
    if (/^\d/.test(name)) out.push(`area ${i + 1} "${name}" starts with a number`);
    if (PREFIX_WORDS.test(name)) out.push(`area ${i + 1} "${name}" starts with an ordinal or weekday`);
  });
  return out;
}

describe('area names do not repeat vocabulary.area or the area number (M5)', () => {
  for (const f of files) {
    it(f, () => {
      expect(areaNameProblems(load(f))).toEqual([]);
    });
  }

  it('the checker flags the shapes from the issue', () => {
    const w = load('nb-troll-direktoratet.json');
    const bad: WorldSpec = {
      ...w,
      areas: w.areas.map((a, i) => ({
        ...a,
        name: ['1. instans: Venterommet', 'Instans to', 'Mandag: Skolen', 'Første dag i arkivet'][i] ?? a.name,
      })),
    };
    expect(areaNameProblems(bad)).toHaveLength(6);
    expect(areaNameProblems(w)).toEqual([]);
  });

  it('the renamed areas keep their meaning', () => {
    expect(load('nb-troll-direktoratet.json').areas.map((a) => a.name)).toEqual([
      'Venterommet',
      'Det uendelige arkivet',
      'Klagefristen',
      'Trehodes kontor',
    ]);
    expect(load('nb-russetid-bussen.json').areas[0]!.name).toBe('Skolen (mandag)');
    expect(load('corporate-merger-kitchen-nb.json').areas[0]!.name).toBe('Felleskjøkkenet');
  });
});

describe('nb grammar fixes (M5)', () => {
  it('nb-russetid-bussen', () => {
    const w = load('nb-russetid-bussen.json');
    const text = raw('nb-russetid-bussen.json');
    expect(w.areas[1]!.description.startsWith('Et jorde ved skogkanten')).toBe(true);
    expect(text).not.toContain('En jorde');
    expect(text).not.toContain('Tunge av knuter');
    expect(text).toContain('Tung av knuter');
    // the game calls a turn "runde" in bokmål
    expect(w.rules[0]!.description).toContain('Hver 20. runde');
    expect(text).not.toMatch(/Hver \d+\. tur\b/);
  });

  it('nb-troll-direktoratet', () => {
    const w = load('nb-troll-direktoratet.json');
    const text = raw('nb-troll-direktoratet.json');
    expect(text).not.toContain('rød teppe');
    expect(w.areas[3]!.description).toContain('rødt teppe');
    expect(text).not.toContain('Rødt strek');
    expect(w.items.some((i) => i.weapon?.name === 'Rød strek')).toBe(true);
    expect(text).not.toContain('Over alt');
    expect(w.areas[2]!.description).toContain('Overalt danser');
  });
});

describe('viking-lawspeaker-althing-nb: the female player is a "lærling" (M5)', () => {
  it('no "læregutt" anywhere, the title says lærling', () => {
    const w = load('viking-lawspeaker-althing-nb.json');
    expect(raw('viking-lawspeaker-althing-nb.json')).not.toMatch(/læregut/i);
    expect(w.player.title).toBe('Lærling hos lovsigemannen');
    expect(w.meta.prompt).toContain('lærlingen hans');
  });
});
