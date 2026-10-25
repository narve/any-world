/**
 * M5 issue item-fx-i18n: item effect lines (item cards, slot tips, trade rows) are catalog lines
 * (ItemView.effects: item.fx.* key + params, English text as fallback) instead of finished English
 * sentences, and the client renders them in the UI language (DESIGN §7b, DoD #11).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { WORLD_DIR, loadFixture, testWorld, newGame, ctxFor } from './helpers';
import { createGame, describeItemDef } from '../../src/engine/index';
import { itemEffectFx, itemEffectLines, effectLine, targetingLine } from '../../src/engine/describe';
import { ITEM_FX_KEYS, renderTemplate } from '../../src/engine/log-keys';
import type { ItemEffectLine } from '../../src/engine/types';
import { setLanguage } from '../../src/client/i18n/index';
import { itemEffectText, itemEffectTexts } from '../../src/client/i18n/engine-text';
import en from '../../src/client/i18n/en';
import nb from '../../src/client/i18n/nb';

afterEach(() => setLanguage('en', { persist: false }));

const worlds = readdirSync(WORLD_DIR).filter((f) => f.endsWith('.json')).sort();

function flat(l: ItemEffectLine): ItemEffectLine[] {
  const subs = Object.values(l.sub ?? {}).flatMap((v) => (Array.isArray(v) ? v : [v]));
  return [l, ...subs.flatMap(flat)];
}

describe('item effect lines are catalog lines', () => {
  it('every item of every shipped world: keys are ITEM_FX_KEYS, text is the English template, effects parallel effectLines', () => {
    const problems: string[] = [];
    let lines = 0;
    for (const f of worlds) {
      const w = loadFixture(f);
      const s = createGame(w, { seed: 1 });
      const ctx = ctxFor(w, s);
      for (const def of w.items) {
        const fx = itemEffectFx(ctx, def);
        expect(fx.map((l) => l.text)).toEqual(itemEffectLines(ctx, def));
        for (const l of fx.flatMap(flat)) {
          lines++;
          const tpl = (ITEM_FX_KEYS as Record<string, string>)[l.key];
          if (!tpl) problems.push(`${f}/${def.id}: unknown key ${l.key}`);
          else if (renderTemplate(tpl, l.params) !== l.text) problems.push(`${f}/${def.id}: ${l.key} text "${l.text}"`);
          if (/[{}]/.test(l.text)) problems.push(`${f}/${def.id}: placeholder in "${l.text}"`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(lines).toBeGreaterThan(200);
  });

  it('ItemView carries both: effectLines (English) and effects (keys) for known items, neither for unknown ones', () => {
    const w = loadFixture('nb-troll-direktoratet.json');
    const s = createGame(w, { seed: 1 });
    const lamp = describeItemDef(s, 'dagslyslykt', { world: w });
    expect(lamp.effects?.map((l) => l.key)).toEqual(['item.fx.damage', 'item.fx.status_inflict', 'item.fx.target_ray', 'item.fx.cost', 'item.fx.cooldown']);
    expect(lamp.effectLines).toEqual(lamp.effects!.map((l) => l.text));
    expect(lamp.effectLines[0]).toBe('Deals 2d4 Sollys damage');
  });

  it('the nb catalog renders the reported lines in bokmål (Dagslyslykt, Kvikklunsj)', () => {
    const w = loadFixture('nb-troll-direktoratet.json');
    const s = createGame(w, { seed: 1 });
    setLanguage('nb', { persist: false });
    const lamp = itemEffectTexts(describeItemDef(s, 'dagslyslykt', { world: w }));
    expect(lamp).toEqual(['Skade: 2d4 Sollys', 'Påfører Halvforsteinet (1 runde)', 'Mål: linje, rekkevidde 5', 'Koster 4 Blekk', 'Nedkjøling: 2 runder']);
    const lunch = itemEffectTexts(describeItemDef(s, 'kvikklunsj', { world: w }));
    expect(lunch.join(' | ')).toMatch(/^Gjenoppretter \d+ Tålmodighet \| Gir Kaffefart \(4 runder\)/);
    setLanguage('en', { persist: false });
    expect(itemEffectTexts(describeItemDef(s, 'dagslyslykt', { world: w }))).toEqual([
      'Deals 2d4 Sollys damage',
      'Inflicts Halvforsteinet (1 turn)',
      'Target: line, range 5',
      'Costs 4 Blekk',
      'Cooldown 2 turns',
    ]);
  });

  it('no item line of the nb worlds is left with English words or placeholders in the nb UI', () => {
    setLanguage('nb', { persist: false });
    const english = /\b(Deals|damage|Restores|Inflicts|Grants|Removes|Target|Costs|Cooldown|Charges|Requires|Durability|chance|while carried|turns?|range|On)\b/;
    const bad: string[] = [];
    let n = 0;
    for (const f of worlds.filter((x) => x.startsWith('nb-') || x.endsWith('-nb.json'))) {
      const w = loadFixture(f);
      expect(w.meta.language).toBe('nb');
      const s = createGame(w, { seed: 1 });
      const ctx = ctxFor(w, s);
      for (const def of w.items) {
        for (const text of itemEffectTexts({ effectLines: itemEffectLines(ctx, def), effects: itemEffectFx(ctx, def) })) {
          n++;
          if (/[{}]/.test(text) || english.test(text)) bad.push(`${f}/${def.id}: ${text}`);
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(n).toBeGreaterThan(50);
  });

  it('sub-lines (scaled amounts, ally targeting, triggers) render through the catalog too', () => {
    const w = testWorld();
    const s = newGame(w, 1);
    const ctx = ctxFor(w, s);
    const charmDef = {
      ...w.items[0],
      id: 'odd-charm',
      weapon: undefined,
      armour: undefined,
      onUse: undefined,
      cost: undefined,
      cooldown: 0,
      modifiers: [],
      requires: [],
      useMode: 'passive' as const,
      triggers: [
        { on: 'on_turn' as const, chance: 1, every: 3, action: { effects: [{ type: 'heal' as const, amount: { base: 1 } }, { type: 'apply_status' as const, status: 'regen', duration: 2 }], targeting: { shape: 'self' as const, range: 0, radius: 0, affects: 'self_only' as const, needsLos: true } } },
      ],
    };
    const charm = itemEffectFx(ctx, charmDef as never);
    const trig = charm.find((l) => l.key === 'item.fx.trigger_every')!;
    expect(trig.text).toBe('On turn (every 3): Restores 1 Health, Grants Mending (2 turns)');
    setLanguage('nb', { persist: false });
    expect(itemEffectText(trig)).toBe('Hver runde (hver 3. runde): Gjenoppretter 1 Health, Gir Mending (2 runder)');
    // scaled amount and an allies suffix
    const scaled = effectLine(ctx, { type: 'damage', amount: { base: 2, dice: '1d4', scale: { stat: 'int', factor: 0.5 } }, damageType: 'fire' });
    expect(scaled).toMatch(/^Deals 1d4\+2 \+ 50% \S+ /);
    expect(targetingLine({ shape: 'area', range: 4, radius: 2, affects: 'allies', needsLos: true })).toBe('Target: area radius 2, range 4, allies');
  });

  it('en and nb catalogs know every item.fx key with the same params', () => {
    for (const k of Object.keys(ITEM_FX_KEYS)) {
      expect((en as Record<string, string>)[k], k).toBeDefined();
      expect((nb as Record<string, string>)[k], k).toBeDefined();
    }
  });
});
