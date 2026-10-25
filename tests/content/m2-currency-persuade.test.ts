/**
 * M2 content regressions (issues/M2-dream-talker-dominant.md, issues/M2-currency-never-earned.md):
 * - the `currency` effect pays the player, so content can put bounties on kills (on_death triggers);
 * - every fixture earns currency in a run and keeps a trader reachable after the first area;
 * - `persuadeDifficulty` on an actor without an npc block sets its persuade check, and the dream
 *   fixture's mindless shapes use it so persuading every hostile is no longer a free win.
 *
 * Win rates are checked with `npm run sim` (too slow for vitest); a small talker run guards the trend.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import { effectLine } from '../../src/engine/describe';
import { runGame } from '../../src/engine/sim';
import { testWorld, newGame, player, addActor, act, ctxFor } from '../engine/helpers';

const dir = join(__dirname, '..', '..', 'content', 'worlds');
const files = readdirSync(dir).filter((f) => f.startsWith('fixture-') && f.endsWith('.json')).sort();
function load(f: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  if (!r.ok) throw new Error(`${f}: ${r.errors.join('\n')}`);
  return r.world;
}
const worlds = Object.fromEntries(files.map((f) => [f.replace(/^fixture-|\.json$/g, ''), load(f)])) as Record<string, WorldSpec>;

const bounty = (amount: number) => ({
  on: 'on_death' as const,
  action: { targeting: { shape: 'self' as const, affects: 'self_only' as const }, effects: [{ type: 'currency' as const, amount }] },
});

/** currency paid by an actor's on_death triggers */
function payout(def: WorldSpec['actors'][number]): number {
  let n = 0;
  for (const t of def.triggers) if (t.on === 'on_death') for (const e of t.action.effects) if (e.type === 'currency') n += e.amount;
  return n;
}

describe('currency effect (engine + schema)', () => {
  it('an on_death bounty pays the player when the actor is defeated', () => {
    const w = testWorld((x) => {
      x.actors[0].triggers = [bounty(3)];
    });
    let s = newGame(w, 1);
    const start = s.player.currency;
    const rat = addActor(w, s, 'rat', { x: 2, y: 1 }, { hp: 1, maxHp: 1 });
    expect(player(s).pos).toEqual({ x: 1, y: 1 });
    for (let i = 0; i < 40 && s.area.actors.some((a) => a.id === rat.id && a.hp > 0); i++) s = act(w, s, { type: 'attack', targetId: rat.id }).state;
    expect(s.area.actors.some((a) => a.id === rat.id && a.hp > 0)).toBe(false);
    expect(s.player.currency).toBe(start + 3);
    expect(s.log.some((m) => m.kind === 'loot' && m.text.includes(`+3 ${w.vocabulary.currency}`))).toBe(true);
  });

  it('is validated as a positive payout (1..100) and described with the world currency name', () => {
    expect(() => testWorld((x) => void (x.actors[0].triggers = [bounty(0)]))).toThrow();
    expect(() => testWorld((x) => void (x.actors[0].triggers = [bounty(101)]))).toThrow();
    expect(() => testWorld((x) => void (x.actors[0].triggers = [bounty(2.5)]))).toThrow();
    const w = testWorld();
    const s = newGame(w, 1);
    expect(effectLine(ctxFor(w, s), { type: 'currency', amount: 4 })).toBe(`+4 ${w.vocabulary.currency}`);
  });
});

describe('fixtures: currency is earned during a run', () => {
  for (const [name, w] of Object.entries(worlds)) {
    it(`${name}: at least 2 kinds of hostile pay a bounty in each area before the last`, () => {
      const defs = new Map(w.actors.map((a) => [a.id, a]));
      for (let i = 0; i < w.areas.length - 1; i++) {
        const ids = new Set([...w.areas[i].actors.map((x) => x.actor), ...w.areas[i].placed.map((x) => x.actor)]);
        // a transforming hostile pays through what it turns into (western tinplate -> scrap crawler)
        for (const id of [...ids]) {
          for (const t of defs.get(id)!.triggers) for (const e of t.action.effects) if (e.type === 'transform') ids.add(e.into);
        }
        const payers = [...ids].filter((id) => defs.get(id)!.faction === 'hostile' && payout(defs.get(id)!) > 0);
        expect(payers.length, `${name} area ${i} payers: ${payers.join(',')}`).toBeGreaterThanOrEqual(2);
      }
    });

    it(`${name}: a trader is placed again after the first area, so bounties can be spent`, () => {
      const traders = new Set(w.actors.filter((a) => a.npc?.role === 'trader').map((a) => a.id));
      const later = w.areas.slice(1).some((ar) => ar.placed.some((p) => traders.has(p.actor)));
      expect(later).toBe(true);
    });

    it(`${name}: the explorer bot earns at least one trader item's worth per run`, () => {
      const cheapest = Math.min(
        ...w.actors
          .filter((a) => a.npc?.role === 'trader')
          .flatMap((a) => a.npc!.stock.slice(0, 4).map((id) => w.items.find((i) => i.id === id)!.value)),
      );
      let earned = 0;
      for (let seed = 1; seed <= 3; seed++) {
        let prev = w.player.startCurrency ?? 0;
        runGame(w, seed, 'explorer', {
          invariants: false,
          maxTurns: 1500,
          onStep: (s) => {
            const d = s.player.currency - prev;
            if (d > 0) earned += d;
            prev = s.player.currency;
          },
        });
      }
      // spending is up to the player (the sim bots only buy what they need), earning is content
      expect(earned / 3).toBeGreaterThanOrEqual(cheapest);
    }, 60_000);
  }
});

describe('persuadeDifficulty on actors without an npc block', () => {
  it('sets the persuade check: a DC 30 hostile only yields to a natural 20', () => {
    const easy = testWorld();
    const hard = testWorld((x) => {
      (x.actors[0] as { persuadeDifficulty?: number }).persuadeDifficulty = 30;
    });
    let calmedEasy = 0;
    let calmedHard = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (const [w, inc] of [
        [easy, () => calmedEasy++],
        [hard, () => calmedHard++],
      ] as const) {
        const s = newGame(w, seed);
        const rat = addActor(w, s, 'rat', { x: 2, y: 1 }, { ai: { alerted: true, home: { x: 2, y: 1 } } });
        const r = act(w, s, { type: 'persuade', targetId: rat.id });
        if (r.state.area.actors.find((a) => a.id === rat.id)?.faction === 'neutral') inc();
      }
    }
    expect(calmedEasy).toBeGreaterThan(30);
    expect(calmedHard).toBeLessThan(12); // ~5% natural 20s
  });

  it('does not make the actor talkable or change its hp scaling (no npc block)', () => {
    const w = testWorld((x) => {
      (x.actors[0] as { persuadeDifficulty?: number }).persuadeDifficulty = 20;
    });
    const s = newGame(w, 1);
    const rat = addActor(w, s, 'rat', { x: 2, y: 1 });
    expect(act(w, s, { type: 'talk', targetId: rat.id }).events[0]).toMatchObject({ type: 'invalid' });
  });

  it('dream: every rank-and-file hostile is hard to talk down (DC >= 17, mindless shapes >= 19)', () => {
    const w = worlds.dream;
    const hostiles = w.actors.filter((a) => a.faction === 'hostile' && !a.npc);
    expect(hostiles.length).toBeGreaterThan(4);
    for (const a of hostiles) expect(a.persuadeDifficulty ?? 0, a.id).toBeGreaterThanOrEqual(17);
    for (const id of ['running-drip', 'dissonant-moth', 'grey-wash', 'acute-angle']) {
      expect(w.actors.find((a) => a.id === id)!.persuadeDifficulty, id).toBeGreaterThanOrEqual(19);
    }
  });

  it('dream: persuading is no shortcut — the talker does not out-win the fighting explorer (seeds 1-12)', () => {
    let talker = 0;
    let explorer = 0;
    for (let seed = 1; seed <= 12; seed++) {
      if (runGame(worlds.dream, seed, 'talker', { invariants: false }).result === 'won') talker++;
      if (runGame(worlds.dream, seed, 'explorer', { invariants: false }).result === 'won') explorer++;
    }
    // before the M2 fix the talker won ~92% by talking everything down while the explorer won ~45%.
    // Since the M5 new-player retune (issues/M5-new-player-deaths.md: The Erasure ×0.85) the world
    // is easier for everyone (200 seeds: talker ~90%, explorer ~84%), so the guard is relative now:
    // the talker may not win clearly more than a bot that fights its way through
    expect(talker).toBeLessThanOrEqual(explorer + 2);
  }, 240_000);
});
