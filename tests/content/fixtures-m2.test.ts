/**
 * M2 content regressions for the fixture worlds (issues/M2-fixtures-too-easy.md,
 * issues/M2-currency-always-zero.md, issues/M2-perk-without-effect-chip.md).
 *
 * The win-rate targets themselves are checked with `npm run sim` (too slow for vitest); these
 * tests pin the cheap, deterministic properties the fixes rely on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import { createGame } from '../../src/engine';
import { staticAnalysis } from '../../src/engine/balance';

const dir = join(__dirname, '..', '..', 'content', 'worlds');
const files = readdirSync(dir).filter((f) => f.startsWith('fixture-') && f.endsWith('.json')).sort();

function load(f: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  if (!r.ok) throw new Error(`${f}: ${r.errors.join('\n')}`);
  return r.world;
}

const worlds = Object.fromEntries(files.map((f) => [f.replace(/^fixture-|\.json$/g, ''), load(f)])) as Record<string, WorldSpec>;

describe('currency is usable without a GM (startCurrency)', () => {
  for (const [name, w] of Object.entries(worlds)) {
    it(`${name}: the run starts with player.startCurrency in hand`, () => {
      expect(w.player.startCurrency ?? 0).toBeGreaterThan(0);
      const s = createGame(w, { seed: 3 });
      expect(s.player.currency).toBe(w.player.startCurrency);
    });

    it(`${name}: every trader offers at least one item the starting purse can buy`, () => {
      const traders = w.actors.filter((a) => a.npc?.role === 'trader');
      expect(traders.length).toBeGreaterThan(0);
      for (const t of traders) {
        // the engine offers the first 4 stock entries (src/engine/npc.ts doTalk)
        const prices = t.npc!.stock.slice(0, 4).map((id) => w.items.find((i) => i.id === id)!.value);
        expect(Math.min(...prices), `${t.id} stock prices ${prices.join(',')}`).toBeLessThanOrEqual(w.player.startCurrency ?? 0);
      }
    });
  }

  it('a world without startCurrency still starts at 0 (backwards compatible)', () => {
    const w = structuredClone(worlds.ship);
    delete w.player.startCurrency;
    expect(createGame(w, { seed: 1 }).player.currency).toBe(0);
  });

  it('startCurrency is validated (non-negative integer)', () => {
    const raw = JSON.parse(readFileSync(join(dir, 'fixture-ship.json'), 'utf8'));
    raw.player.startCurrency = -5;
    expect(parseWorld(raw).ok).toBe(false);
    raw.player.startCurrency = 2.5;
    expect(parseWorld(raw).ok).toBe(false);
  });
});

describe('perks without stat/item chips spell out their mechanics', () => {
  for (const [name, w] of Object.entries(worlds)) {
    it(`${name}: trigger-only perks give a number in their description`, () => {
      const bare = w.player.growth.perks.filter((p) => !p.modifiers.length && !p.grantItems.length);
      for (const p of bare) expect(p.description, `${p.id}: "${p.description}"`).toMatch(/\d/);
    });
  }
});

describe('fixture difficulty (normal) — static guards behind the sim tuning', () => {
  for (const name of ['teen', 'western', 'dream']) {
    it(`${name}: the first area does not hand out more healing than it can take away`, () => {
      const a0 = staticAnalysis(worlds[name]).areas[0];
      // before the fix: teen 58 dmg vs 86 healing, western 60 vs 73
      expect(a0.fightDamage + a0.ruleDamage).toBeGreaterThanOrEqual(0.9 * a0.healing);
    });

    it(`${name}: the final boss is a real threat in a straight fight`, () => {
      const areas = staticAnalysis(worlds[name]).areas;
      // before the fix: teen 0.90, western 1.06, dream 1.19
      expect(areas[areas.length - 1].bossRisk ?? 0).toBeGreaterThanOrEqual(1.3);
    });
  }

  it('dream: a new layer refills at most 25 Saturation (the pacifist walk costs colour)', () => {
    const rule = worlds.dream.rules.find((r) => r.id === 'drying-time')!;
    const refill = rule.playerTriggers
      .filter((t) => t.on === 'on_area_enter')
      .flatMap((t) => t.action.effects)
      .filter((e) => e.type === 'resource' && e.resource === 'hue')
      .reduce((n, e) => n + (e.type === 'resource' ? (e.amount.base ?? 0) : 0), 0);
    expect(refill).toBeGreaterThan(0);
    expect(refill).toBeLessThanOrEqual(25);
  });
});
