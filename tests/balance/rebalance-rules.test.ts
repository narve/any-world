/**
 * rebalance: softening rules never deletes them, and "too easy" never enables disabled healing.
 * (Moved here from tests/review/m2/round1.test.ts once fixed.)
 */
import { describe, it, expect } from 'vitest';
import type { Trigger, WorldSpec } from '../../src/schema/world';
import { rebalance } from '../../src/engine/balance';
import { softenAmount } from '../../src/engine/balance/rebalance';
import { loadFixture } from '../engine/helpers';

const ship = loadFixture('fixture-ship.json');
const self = { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: false } as const;

function withRule(base: WorldSpec, id: string, tr: Trigger): WorldSpec {
  const w = structuredClone(base);
  w.rules = [...w.rules.slice(0, 2), { id, name: id, description: 'd', playerTriggers: [tr], switches: {} }];
  return w;
}

const tooHard = { verdict: 'too_hard', winRate: 0.1, target: [0.25, 0.6], reasons: [], suggestions: [], sims: [] } as never;
const tooEasy = { verdict: 'too_easy', winRate: 0.99, target: [0.25, 0.6], reasons: [], suggestions: [], sims: [] } as never;

describe('softenAmount', () => {
  it('halves magnitudes but keeps sign and at least 1', () => {
    expect(softenAmount({ base: -1 }, 0.5).base).toBe(-1);
    expect(softenAmount({ base: -2 }, 0.5).base).toBe(-1);
    expect(softenAmount({ base: -5 }, 0.5).base).toBe(-3);
    expect(softenAmount({ base: 1 }, 0.5).base).toBe(1);
    expect(softenAmount({ base: 6 }, 0.5).base).toBe(3);
    expect(softenAmount({ base: 0, dice: '2d6' }, 0.5)).toEqual({ base: 0, dice: '2d3' });
    expect(softenAmount({ base: 0, dice: '1d2' }, 0.5)).toEqual({ base: 0, dice: '1d2' });
  });
});

describe('rebalance: softenRules', () => {
  it('too_hard keeps a -1 resource drain rule as a drain (it fires less often instead)', () => {
    const world = withRule(ship, 'review-leak', { on: 'on_turn', every: 1, chance: 1, action: { targeting: self, effects: [{ type: 'resource', resource: 'oxygen', amount: { base: -1 } }] } });
    const res = rebalance(world, tooHard);
    expect(res.valid).toBe(true);
    const tr = res.world.rules.find((r) => r.id === 'review-leak')!.playerTriggers[0];
    const eff = tr.action.effects[0] as { amount: { base: number } };
    expect(eff.amount.base).toBe(-1);
    expect(tr.every).toBe(2);
    expect(res.changes).toContain('rule "review-leak" softened (on_turn slower)');
  });

  it('repeated softening never reaches zero (tuneWorld applies it every round)', () => {
    let world = withRule(ship, 'review-leak', { on: 'on_turn', every: 1, chance: 1, action: { targeting: self, effects: [{ type: 'resource', resource: 'oxygen', amount: { base: -2 } }] } });
    for (let i = 0; i < 4; i++) world = rebalance(world, tooHard).world;
    const eff = world.rules.find((r) => r.id === 'review-leak')!.playerTriggers[0].action.effects[0] as { amount: { base: number } };
    expect(eff.amount.base).toBe(-1);
  });

  it('a base-1 damage rule that is not on_turn is not reported as softened when nothing changed', () => {
    const world = withRule(ship, 'sting', { on: 'on_hurt', chance: 1, action: { targeting: self, effects: [{ type: 'damage', amount: { base: 1 }, damageType: 'physical' }] } });
    const res = rebalance(world, tooHard);
    expect(res.changes.some((c) => c.startsWith('rule "sting"'))).toBe(false);
  });
});

describe('rebalance: cutHealing', () => {
  it('too_easy never enables a healing spawn entry that had weight 0', () => {
    const w = structuredClone(ship);
    const e = w.areas[0].items.find((x) => x.item === 'ampoule-medgel')!;
    e.weight = 0;
    const res = rebalance(w, tooEasy);
    expect(res.valid).toBe(true);
    expect(res.world.areas[0].items.find((x) => x.item === 'ampoule-medgel')!.weight).toBe(0);
  });
});
