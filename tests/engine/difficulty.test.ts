/**
 * Difficulty (gentle | normal | hard | brutal): stored in the state and saves, hostile hp and
 * damage, natural regeneration; plus the loss reason naming the killer and damage kind.
 */
import { describe, it, expect } from 'vitest';
import { createGame, deserialize, serialize, DIFFICULTY_PROFILES } from '../../src/engine';
import type { GameState } from '../../src/engine/types';
import { dealDamage } from '../../src/engine/combat';
import { checkEnd } from '../../src/engine/turn';
import { applyStatus } from '../../src/engine/statuses';
import { makeActor } from '../../src/engine/actors';
import { testWorld, player, act, addActor, ctxFor, loadFixture, roomMap, simpleGenerator } from './helpers';
import type { WorldSpec } from '../../src/schema/world';

type Band = NonNullable<GameState['difficulty']>;
const BANDS: Band[] = ['gentle', 'normal', 'hard', 'brutal'];

function game(w: WorldSpec, difficulty?: Band, seed = 1): GameState {
  return createGame(w, { seed, map: roomMap(), mapGenerator: simpleGenerator, ...(difficulty ? { difficulty } : {}) });
}

describe('difficulty: state and saves', () => {
  it('createGame stores the band (default normal) and saves keep it', () => {
    const w = testWorld();
    expect(game(w).difficulty).toBe('normal');
    for (const d of BANDS) {
      const s = game(w, d);
      expect(s.difficulty).toBe(d);
      expect(deserialize(w, serialize(s)).difficulty).toBe(d);
    }
  });

  it('an unknown band is treated as normal', () => {
    const w = testWorld();
    const s = createGame(w, { seed: 1, map: roomMap(), mapGenerator: simpleGenerator, difficulty: 'nightmare' as Band });
    expect(s.difficulty).toBe('normal');
  });

  it('gentle and brutal runs of the same seed differ (fixture-teen, generated maps)', () => {
    const teen = loadFixture('fixture-teen.json');
    const a = createGame(teen, { seed: 5, difficulty: 'gentle' });
    const b = createGame(teen, { seed: 5, difficulty: 'brutal' });
    expect(serialize(a)).not.toBe(serialize(b));
    const hostiles = (s: GameState) => s.area.actors.filter((x) => x.faction === 'hostile').map((x) => x.maxHp);
    const ha = hostiles(a);
    const hb = hostiles(b);
    expect(ha.length).toBeGreaterThan(0);
    expect(ha.length).toBe(hb.length);
    for (let i = 0; i < ha.length; i++) expect(ha[i]).toBeLessThanOrEqual(hb[i]);
    expect(ha.reduce((x, y) => x + y, 0)).toBeLessThan(hb.reduce((x, y) => x + y, 0));
  });
});

describe('difficulty: hostiles', () => {
  it('hostile hp scales with the band; NPCs and allies do not', () => {
    const w = testWorld();
    for (const d of BANDS) {
      const s = game(w, d);
      const ctx = ctxFor(w, s);
      const golem = makeActor(ctx, 'golem', { x: 3, y: 3 })!;
      expect(golem.maxHp).toBe(Math.round(40 * DIFFICULTY_PROFILES[d].hostileHp));
      expect(golem.hp).toBe(golem.maxHp);
      expect(makeActor(ctx, 'sage', { x: 4, y: 4 })!.maxHp).toBe(10);
      expect(makeActor(ctx, 'golem', { x: 5, y: 5 }, { allyOf: s.player.actorId })!.maxHp).toBe(40);
    }
  });

  it('damage from hostiles to the player side scales; the player hitting hostiles does not', () => {
    const w = testWorld();
    const dealtToGolem: number[] = [];
    for (const d of BANDS) {
      const s = game(w, d);
      const rat = addActor(w, s, 'rat', { x: 2, y: 1 });
      const ctx = ctxFor(w, s);
      const p = player(s);
      const before = p.hp;
      dealDamage(ctx, p, 10, 'physical', rat.id);
      expect(before - p.hp).toBe(Math.round(10 * DIFFICULTY_PROFILES[d].hostileDamage));
      const golem = addActor(w, s, 'golem', { x: 3, y: 3 });
      const g0 = golem.hp;
      dealDamage(ctx, golem, 10, 'physical', p.id);
      dealtToGolem.push(g0 - golem.hp);
      // harm without a hostile source (rules, statuses without a source, terrain) is not scaled
      const p1 = p.hp;
      dealDamage(ctx, p, 3, 'fire');
      expect(p1 - p.hp).toBe(3);
    }
    expect(new Set(dealtToGolem).size).toBe(1);
  });
});

describe('difficulty: natural regeneration', () => {
  it('slower on harder bands, faster on gentle', () => {
    const w = testWorld((x) => {
      x.player.hpRegenEvery = 4;
    });
    const healed: Record<string, number> = {};
    for (const d of BANDS) {
      let s = game(w, d);
      player(s).hp = 5;
      for (let i = 0; i < 24; i++) s = act(w, s, { type: 'wait' }).state;
      healed[d] = player(s).hp - 5;
    }
    // intervals 3 / 4 / 5 / 6 over 24 turns
    expect(healed).toEqual({ gentle: 8, normal: 6, hard: 4, brutal: 4 });
    expect(healed.gentle).toBeGreaterThan(healed.normal);
    expect(healed.normal).toBeGreaterThan(healed.hard);
  });
});

describe('loss reason', () => {
  it('names the killer and a named damage kind', () => {
    const w = testWorld();
    const s = game(w);
    const archer = addActor(w, s, 'archer', { x: 3, y: 1 });
    const ctx = ctxFor(w, s);
    player(s).hp = 2;
    dealDamage(ctx, player(s), 5, 'fire', archer.id);
    expect(s.status).toBe('lost');
    expect(s.endReason).toBe('bested by Archer (fire)');
  });

  it('uses the last harm when the killer is gone (a status it applied, then it left)', () => {
    const w = testWorld();
    const s = game(w);
    const archer = addActor(w, s, 'archer', { x: 3, y: 1 });
    const ctx = ctxFor(w, s);
    dealDamage(ctx, player(s), 1, 'fire', archer.id);
    s.area.actors = s.area.actors.filter((a) => a !== archer);
    player(s).hp = 0;
    checkEnd(ctx);
    expect(s.endReason).toBe('bested by Archer (fire)');
  });

  it('a sourceless status death says what kind of harm it was', () => {
    const w = testWorld();
    let s = game(w);
    player(s).hp = 1;
    applyStatus(ctxFor(w, s), player(s), 'burning', 5);
    for (let i = 0; i < 3 && s.status === 'playing'; i++) s = act(w, s, { type: 'wait' }).state;
    expect(s.status).toBe('lost');
    expect(s.endReason).toBe('bested (fire)');
  });
});
