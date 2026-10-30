/**
 * MP2 C1: bosses (unique hostiles) get tougher with the party, on top of MP1's party scaling: hp by
 * PARTY_SCALING.uniqueHp (1.0 per extra player; 0.8 until the owner's O4, 2026-10-30) and the damage they
 * deal by uniqueDamage (0.2; was 0.1).
 * Parties of two or more only: a party of one is unchanged (the golden replay checks the rest).
 */
import { describe, it, expect } from 'vitest';
import { addActor, roomMap, simpleGenerator, testWorld } from './helpers';
import { PARTY_SCALING, createGame, partyFactor } from '../../src/engine';
import { indexWorld, type Ctx } from '../../src/engine/ctx';
import { spawnActor } from '../../src/engine/actors';
import { dealDamage } from '../../src/engine/combat';
import { rngFromState } from '../../src/engine/rng';
import type { Difficulty } from '../../src/schema/gm';
import type { GameState } from '../../src/engine/types';

const w = testWorld();

function game(n: number, difficulty: Difficulty = 'normal'): GameState {
  return createGame(w, {
    seed: 4,
    difficulty,
    map: roomMap(14, 12),
    mapGenerator: simpleGenerator,
    ...(n > 1 ? { players: Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}` })) } : {}),
  });
}

const ctxOf = (s: GameState): Ctx => ({ world: w, ix: indexWorld(w), s, pid: s.party[0], rng: rngFromState(s.rng), events: [], mapGen: simpleGenerator, depth: 0 });
const lead = (s: GameState) => s.area.actors.find((a) => a.id === s.players[s.party[0]].actorId)!;

/** hp the lead loses to a raw hit of 10 from a fresh `defId` */
function hitFrom(n: number, defId: string, difficulty: Difficulty = 'normal'): number {
  const s = game(n, difficulty);
  const src = addActor(w, s, defId, { x: 6, y: 6 });
  const p = lead(s);
  const hp = p.hp;
  dealDamage(ctxOf(s), p, 10, 'physical', src.id, { quiet: true });
  return hp - p.hp;
}

describe('bosses scale with the party', () => {
  it('the factors', () => {
    expect(PARTY_SCALING.uniqueHp).toBe(1);
    expect(PARTY_SCALING.uniqueDamage).toBe(0.2);
    expect(partyFactor(4, PARTY_SCALING.uniqueDamage)).toBeCloseTo(1.6);
  });

  it.each([
    // n, boss hp: 20 × 1.25 (UNIQUE_HOSTILE_HP) × (1 + 1.0·(n − 1)), rounded
    [1, 25],
    [2, 50],
    [3, 75],
    [4, 100],
    [12, 300],
  ])('a party of %i meets a boss with %i hp', (n, hp) => {
    const s = game(n);
    const boss = spawnActor(ctxOf(s), 'boss', { x: 8, y: 8 })!;
    expect(boss.maxHp).toBe(hp);
    expect(boss.hp).toBe(hp);
  });

  it('a boss hits a party harder; a party of one and ordinary hostiles are unchanged', () => {
    expect(hitFrom(1, 'boss')).toBe(10);
    expect(hitFrom(2, 'boss')).toBe(12);
    expect(hitFrom(4, 'boss')).toBe(16);
    // 12 players: ×3.2 = 32, more than the test player's hp (the second chance would hide it)
    expect(hitFrom(8, 'boss')).toBe(24);
    expect(hitFrom(1, 'rat')).toBe(10);
    expect(hitFrom(4, 'rat')).toBe(10);
  });

  it('the band multiplies with it: Hard for four players', () => {
    // 10 × 1.15 × 1.6 = 18.4
    expect(hitFrom(4, 'boss', 'hard')).toBe(18);
    expect(hitFrom(1, 'boss', 'hard')).toBe(12);
  });

  it('a boss does not hit its own side harder', () => {
    const s = game(4);
    const boss = addActor(w, s, 'boss', { x: 6, y: 6 });
    const rat = addActor(w, s, 'rat', { x: 7, y: 6 }, { hp: 50, maxHp: 50 });
    dealDamage(ctxOf(s), rat, 10, 'physical', boss.id, { quiet: true });
    expect(rat.hp).toBe(40);
  });
});
