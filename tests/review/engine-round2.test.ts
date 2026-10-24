/**
 * Adversarial engine review, round 2 — repro tests. Each test asserts the CORRECT behaviour, so a
 * failing test is the evidence for a confirmed bug (see issues/ and the review report).
 * Repros of the fixed engine issues moved to tests/engine/review-r2.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { describeItem, step } from '../../src/engine';
import { env, newGame, testWorld } from '../engine/helpers';

const model = { archetype: 'blob', colors: { primary: '#888888' } } as const;

describe('review r2: inventory', () => {
  it('a stack of consumed items with a cooldown respects the cooldown between uses', () => {
    const world = testWorld((w) => {
      (w.items as unknown[]).push({
        id: 'bomb',
        name: 'Bomb',
        kind: 'Bomb',
        description: 'boom',
        category: 'consumable',
        useMode: 'consumed',
        stackable: true,
        cooldown: 5,
        onUse: { targeting: { shape: 'self', range: 0, radius: 0, affects: 'self_only' }, effects: [{ type: 'noise', radius: 3 }] },
        model,
      });
      (w.player as { startingItems: unknown[] }).startingItems.push({ item: 'bomb', count: 3 });
    });
    let s = newGame(world);
    const slot = s.player.slots.findIndex((it) => it?.defId === 'bomb');
    s = step(s, { type: 'use', slot }, env(world)).state;
    expect(s.player.slots[slot]?.count).toBe(2);
    const r = step(s, { type: 'use', slot }, env(world));
    expect(r.events.some((e) => e.type === 'invalid')).toBe(true);
  });
});

describe('review r2: item knowledge in effect lines', () => {
  it('a known item that produces an unknown item does not reveal the produced item\'s real name', () => {
    const world = testWorld((w) => {
      (w.items as unknown[]).push({
        id: 'still',
        name: 'Field Still',
        kind: 'Kit',
        description: 'brews something',
        category: 'tool',
        useMode: 'reusable',
        knowledge: 'clear',
        onUse: { targeting: { shape: 'self', range: 0, radius: 0, affects: 'self_only' }, effects: [{ type: 'spawn_item', item: 'murk', count: 1 }] },
        model,
      });
      (w.player as { startingItems: unknown[] }).startingItems.push({ item: 'still' });
    });
    const s = newGame(world);
    expect(s.knowledge.murk.level).toBe('unknown');
    const it = s.player.slots.find((x) => x?.defId === 'still')!;
    const view = describeItem(s, it.id, env(world));
    expect(view.effectLines.join(' | ')).not.toContain('Murky Draught');
  });
});
