/**
 * Adversarial engine review, round 3 — repro tests. Each test asserts the CORRECT behaviour, so a
 * failing test is the evidence for a confirmed bug. (Round-2 repros that are still open live in
 * engine-round2.test.ts; the fixed ones moved to tests/engine/review-r2.test.ts. Fixed round-3
 * repros moved to tests/engine/review-r3.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { describeInventory, step, leadPlayer } from '../../src/engine';
import type { GameState } from '../../src/engine/types';
import { env, newGame, testWorld } from '../engine/helpers';

const model = { archetype: 'blob', colors: { primary: '#888888' } } as const;
const selfT = { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: false } as const;

function slotOf(s: GameState, defId: string): number {
  return leadPlayer(s).slots.findIndex((it) => it?.defId === defId);
}

describe('review r3: inventory', () => {
  it('a cooldown of 1 turn blocks the very next turn', () => {
    const world = testWorld((w) => {
      (w.items as unknown[]).push({
        id: 'bell',
        name: 'Bell',
        kind: 'Bell',
        description: 'ring it',
        category: 'tool',
        useMode: 'reusable',
        cooldown: 1,
        onUse: { targeting: selfT, effects: [{ type: 'noise', radius: 4 }] },
        model,
      });
      (w.player as { startingItems: unknown[] }).startingItems.push({ item: 'bell' });
    });
    let s = newGame(world);
    const slot = slotOf(s, 'bell');
    s = step(s, { type: 'use', slot }, env(world)).state;
    const r = step(s, { type: 'use', slot }, env(world));
    expect(r.events.some((e) => e.type === 'invalid')).toBe(true);
  });
});

describe('review r3: item knowledge', () => {
  it('"all consumables unknown" gives different unknown items different appearances', () => {
    const world = testWorld((w) => {
      (w as { rules: unknown[] }).rules = [{ id: 'mystery', name: 'Mystery', description: 'nothing is labelled', switches: { allConsumablesUnknown: true } }];
      (w.items as unknown[]).push({
        id: 'poison',
        name: 'Rat Poison',
        kind: 'Flask',
        description: 'deadly',
        category: 'consumable',
        useMode: 'consumed',
        stackable: true,
        onUse: { targeting: selfT, effects: [{ type: 'damage', amount: { base: 10 } }] },
        model,
      });
      (w.player as { startingItems: unknown[] }).startingItems.push({ item: 'poison' });
    });
    const s = newGame(world);
    const inv = describeInventory(s, env(world));
    const tonic = inv[slotOf(s, 'tonic')]!;
    const poison = inv[slotOf(s, 'poison')]!;
    expect(tonic.knowledge).toBe('unknown');
    expect(poison.knowledge).toBe('unknown');
    expect(tonic.name).not.toBe(poison.name);
  });
});
