import { describe, expect, it } from 'vitest';
import { contrast, ensureContrast, mix, parseHex, textOn, themeVars, toHex, DEFAULT_PALETTE } from '../../src/client/ui/theme';
import {
  DEFAULT_VOCABULARY,
  UNKNOWN_ITEM_TEXT,
  areaLabel,
  barText,
  cooldownFraction,
  difficultyLabel,
  toDifficulty,
  DIFFICULTIES,
  itemGlyph,
  knowledgeLines,
  pct,
  pickCards,
  presetNotes,
  runStatLines,
  stackText,
  typewriterCount,
  typewriterSpeed,
  weirdnessLabel,
} from '../../src/client/ui/format';
import type { ItemView } from '../../src/engine/types';
import type { ProviderPreset } from '../../src/llm/types';
import { DEMO_PRESETS, DEMO_VOCAB } from '../../src/client/ui/demo-data';

describe('theme colour math', () => {
  it('parses and formats hex', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#a0c4ff')).toEqual([160, 196, 255]);
    expect(parseHex('nonsense')).toEqual([128, 128, 128]);
    expect(toHex([255, 0, 16])).toBe('#ff0010');
    expect(toHex([300, -5, 12.6])).toBe('#ff000d');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5);
    expect(textOn('#000000')).toBe('#ffffff');
    expect(textOn('#ffffff')).toBe('#111111');
  });

  it('ensureContrast leaves good pairs alone and fixes bad ones', () => {
    expect(ensureContrast('#ffffff', '#000000', 4.5)).toBe('#ffffff');
    const fixed = ensureContrast('#333333', '#222222', 4.5);
    expect(contrast(fixed, '#222222')).toBeGreaterThanOrEqual(4.5);
    const onLight = ensureContrast('#eeeeee', '#ffffff', 4.5);
    expect(contrast(onLight, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('themeVars guarantees readable text even for an AI palette with poor contrast', () => {
    const bad = { primary: '#222222', secondary: '#202020', accent: '#252525', danger: '#2a1010', ui: '#1a1a1a', text: '#2b2b2b' };
    const v = themeVars(bad);
    expect(contrast(v['--c-text'], v['--c-panel'])).toBeGreaterThanOrEqual(7);
    expect(contrast(v['--c-muted'], v['--c-panel'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v['--c-accent'], v['--c-panel'])).toBeGreaterThanOrEqual(3);
    expect(contrast(v['--c-danger'], v['--c-panel'])).toBeGreaterThanOrEqual(3);
    expect(v['color-scheme']).toBe('dark');
  });

  it('supports light UI palettes', () => {
    const v = themeVars({ ...DEFAULT_PALETTE, ui: '#f4efe6', text: '#f0f0f0' });
    expect(v['color-scheme']).toBe('light');
    expect(contrast(v['--c-text'], '#f4efe6')).toBeGreaterThanOrEqual(7);
    expect(v['--c-panel-rgb']).toBe('244, 239, 230');
  });
});

const baseItem: ItemView = {
  name: 'Postal Peacemaker',
  kind: 'Six-shooter',
  description: '',
  knowledge: 'clear',
  effectLines: ['Shoots for 1d8'],
  notes: [],
  count: 1,
  equipped: false,
  usable: false,
  color: '#7c8590',
};

describe('format helpers', () => {
  it('pct and barText are safe', () => {
    expect(pct(5, 10)).toBe(50);
    expect(pct(15, 10)).toBe(100);
    expect(pct(-1, 10)).toBe(0);
    expect(pct(3, 0)).toBe(0);
    expect(barText(9.4, 32)).toBe('9 / 32');
    expect(barText(-3, 10)).toBe('0 / 10');
  });

  it('labels areas with the world vocabulary', () => {
    expect(areaLabel(DEMO_VOCAB, 1, 4)).toBe('Stretch 2 / 4');
    expect(areaLabel(DEFAULT_VOCABULARY, 0, 0)).toBe('Area 1');
  });

  it('item glyphs: initial, skips articles, custom glyph, unknown is "?"', () => {
    expect(itemGlyph(baseItem)).toBe('P');
    expect(itemGlyph({ ...baseItem, name: 'The Thunder Jar' })).toBe('T');
    expect(itemGlyph({ ...baseItem, name: 'a rusty key' })).toBe('R');
    expect(itemGlyph({ ...baseItem, name: 'ölkanne' })).toBe('Ö');
    expect(itemGlyph({ ...baseItem, glyph: '✦' })).toBe('✦');
    expect(itemGlyph({ ...baseItem, knowledge: 'unknown', glyph: 'X' })).toBe('?');
    expect(itemGlyph({ ...baseItem, name: '...' })).toBe('•');
  });

  it('knowledge-aware lines', () => {
    expect(knowledgeLines(baseItem)).toEqual({ kind: 'exact', lines: ['Shoots for 1d8'] });
    expect(knowledgeLines({ ...baseItem, knowledge: 'vague', vagueText: 'It hums.' })).toEqual({ kind: 'vague', lines: ['It hums.'] });
    expect(knowledgeLines({ ...baseItem, knowledge: 'vague' })).toEqual({ kind: 'vague', lines: [] });
    const unknown = knowledgeLines({ ...baseItem, knowledge: 'unknown', effectLines: ['SECRET'] });
    expect(unknown).toEqual({ kind: 'unknown', lines: [UNKNOWN_ITEM_TEXT] });
    expect(UNKNOWN_ITEM_TEXT).toBe('Unknown — could be anything');
  });

  it('stack / charges badge text', () => {
    expect(stackText({ count: 1, stackable: false })).toBe('');
    expect(stackText({ count: 3, stackable: true })).toBe('×3');
    expect(stackText({ count: 1, stackable: true })).toBe('');
    expect(stackText({ count: 1, stackable: false, charges: 2, maxCharges: 3 })).toBe('2/3');
    expect(stackText({ count: 1, stackable: false, charges: 0 })).toBe('0');
  });

  it('cooldown fraction', () => {
    expect(cooldownFraction({})).toBe(0);
    expect(cooldownFraction({ cooldown: 0, maxCooldown: 5 })).toBe(0);
    expect(cooldownFraction({ cooldown: 2, maxCooldown: 4 })).toBe(0.5);
    expect(cooldownFraction({ cooldown: 3 })).toBe(1);
    expect(cooldownFraction({ cooldown: 9, maxCooldown: 4 })).toBe(1);
  });

  it('run stats use vocabulary words', () => {
    const lines = runStatLines({ turns: 10, kills: 3, itemsUsed: 1, damageDealt: 5, damageTaken: 4, areasCleared: 1, areaCount: 4, level: 2 }, DEMO_VOCAB);
    const labels = lines.map((l) => l.label);
    expect(labels).toContain('Put in the dirt');
    expect(labels).toContain('Stretch reached');
    expect(labels).toContain('Reputation level');
    expect(lines.find((l) => l.label === 'Stretch reached')!.value).toBe('2 / 4');
    const won = runStatLines({ turns: 10, kills: 3, itemsUsed: 1, damageDealt: 5, damageTaken: 4, areasCleared: 4, areaCount: 4, level: 2 }, DEMO_VOCAB);
    expect(won.find((l) => l.label === 'Stretch reached')!.value).toBe('4 / 4');
  });

  it('typewriter progression and reduce-motion', () => {
    expect(typewriterCount('hello', 0, 10)).toBe(0);
    expect(typewriterCount('hello', 200, 10)).toBe(2);
    expect(typewriterCount('hello', 10_000, 10)).toBe(5);
    expect(typewriterCount('hello', 0, Infinity)).toBe(5);
    expect(typewriterSpeed(1, true)).toBe(Infinity);
    expect(typewriterSpeed(2, false)).toBeGreaterThan(typewriterSpeed(1, false));
  });

  it('slider labels', () => {
    expect(difficultyLabel(0)).toBe('Gentle');
    expect(difficultyLabel('gentle')).toBe('Gentle');
    expect(difficultyLabel(3)).toBe('Brutal');
    expect(difficultyLabel(99)).toBe('Brutal');
    expect(difficultyLabel('hard')).toBe('Hard');
    expect(toDifficulty('nonsense')).toBe('normal');
    expect(toDifficulty(1)).toBe('normal');
    expect(DIFFICULTIES).toEqual(['gentle', 'normal', 'hard', 'brutal']);
    expect(weirdnessLabel(0)).toBe('Familiar');
    expect(weirdnessLabel(1)).toBe('Unhinged');
  });

  it('pickCards returns n distinct entries deterministically for a given rand', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f'];
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const a = pickCards(list, 4, rand);
    expect(a).toHaveLength(4);
    expect(new Set(a).size).toBe(4);
    seed = 1;
    expect(pickCards(list, 4, rand)).toEqual(a);
    expect(pickCards(list, 10, Math.random)).toHaveLength(6);
    expect(list).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('preset notes explain region, CORS and key storage', () => {
    const deepseek = DEMO_PRESETS.find((p) => p.id === 'deepseek') as ProviderPreset;
    const direct = presetNotes(deepseek, 'direct');
    expect(direct[0].text).toContain('China');
    expect(direct.some((n) => n.warn && /backend/i.test(n.text))).toBe(true);
    expect(direct.some((n) => /only in this browser/.test(n.text))).toBe(true);
    const backend = presetNotes(deepseek, 'backend');
    expect(backend.some((n) => n.warn)).toBe(false);
    expect(backend.some((n) => /server holds the API key/.test(n.text))).toBe(true);
    const ollama = presetNotes(DEMO_PRESETS.find((p) => p.id === 'ollama'), 'direct');
    expect(ollama.some((n) => /only in this browser/.test(n.text))).toBe(false);
    expect(presetNotes(undefined, 'direct')[0].text).toMatch(/Custom/);
  });
});
