import { describe, it, expect } from 'vitest';
import { testWorld, newGame, ctxFor, player, addActor, roomMap, act, ScriptedRng } from './helpers';
import { performAttack, attackOf, inAttackRange, dealDamage } from '../../src/engine/combat';
import { energyGain, sightRadius } from '../../src/engine/stats';
import { applyStatus } from '../../src/engine/statuses';
import { giveItem } from '../../src/engine/inventory';
import type { WorldSpecInput } from '../../src/schema';
import type { GameState } from '../../src/engine/types';

function setup(patch?: (w: WorldSpecInput) => void, map = roomMap()) {
  const w = testWorld(patch);
  const s = newGame(w, 1, map);
  return { w, s, p: player(s) };
}

describe('combat math', () => {
  it('natural 20 always hits and crits; natural 1 always misses', () => {
    const { w, s, p } = setup();
    const g = addActor(w, s, 'golem', { x: 2, y: 1 }, { base: { str: 16, dex: 10, int: 10, ac: 99, speed: 100, sight: 7 } });
    const r20 = performAttack(ctxFor(w, s, new ScriptedRng([20])), p, g);
    expect(r20).toMatchObject({ hit: true, crit: true, roll: 20 });
    const rat = addActor(w, s, 'rat', { x: 1, y: 2 }, { base: { str: 6, dex: 10, int: 10, ac: 0, speed: 100, sight: 7 } });
    const r1 = performAttack(ctxFor(w, s, new ScriptedRng([1])), p, rat);
    expect(r1).toMatchObject({ hit: false, roll: 1 });
  });

  it('hits when d20 + stat mod (+2 vs unaware) >= AC', () => {
    const { w, s, p } = setup();
    // stick uses STR (12 → +1); rat AC 8; unaware +2 → needs 5
    const mk = () => addActor(w, s, 'rat', { x: 2, y: 1 }, { hp: 99, maxHp: 99 });
    let rat = mk();
    expect(performAttack(ctxFor(w, s, new ScriptedRng([5])), p, rat).hit).toBe(true);
    s.area.actors = s.area.actors.filter((a) => a !== rat);
    rat = mk();
    expect(performAttack(ctxFor(w, s, new ScriptedRng([4])), p, rat).hit).toBe(false);
    rat.ai.alerted = true; // aware now: needs 7
    expect(performAttack(ctxFor(w, s, new ScriptedRng([6])), p, rat).hit).toBe(false);
    expect(performAttack(ctxFor(w, s, new ScriptedRng([7])), p, rat).hit).toBe(true);
  });

  it('damage stays within weapon bounds (normal and critical)', () => {
    const { w, s, p } = setup();
    const g = addActor(w, s, 'rat', { x: 2, y: 1 }, { hp: 100000, maxHp: 100000 });
    for (let i = 0; i < 300; i++) {
      const roll = i % 2 ? 15 : 20;
      const r = performAttack(ctxFor(w, s, new ScriptedRng([roll], i)), p, g);
      // stick 2+1d4, +1 STR mod; crit doubles dice
      if (roll === 20) expect(r.damage >= 5 && r.damage <= 11).toBe(true);
      else expect(r.damage >= 4 && r.damage <= 7).toBe(true);
    }
  });

  it('resistances: 0 → immune, 0.5 → halved (min 1 when > 0)', () => {
    const { w, s, p } = setup();
    const ctx = ctxFor(w, s);
    const g = addActor(w, s, 'golem', { x: 3, y: 3 });
    expect(dealDamage(ctx, g, 10, 'fire', p.id)).toBe(0);
    expect(dealDamage(ctx, g, 10, 'physical', p.id)).toBe(5);
    expect(dealDamage(ctx, g, 1, 'physical', p.id)).toBe(1);
    expect(g.hp).toBe(34);
  });

  it('ranged attacks need range and line of sight', () => {
    const map = roomMap(12, 10, { walls: [{ x: 3, y: 1 }] });
    const { w, s, p } = setup(undefined, map);
    const ctx = ctxFor(w, s);
    p.base.dex = 14;
    giveItem(ctx, 'bow', 1);
    const slot = s.player.slots.findIndex((x) => x?.defId === 'bow');
    s.player.equipped.weapon = slot;
    const atk = attackOf(ctx, p)!.attack;
    expect(atk.range).toBe(6);
    const hidden = addActor(w, s, 'rat', { x: 5, y: 1 });
    const open = addActor(w, s, 'rat', { x: 5, y: 4 });
    const far = addActor(w, s, 'rat', { x: 9, y: 8 });
    expect(inAttackRange(ctx, p, hidden, atk)).toBe(false);
    expect(inAttackRange(ctx, p, open, atk)).toBe(true);
    expect(inAttackRange(ctx, p, far, atk)).toBe(false);
  });

  it('kills grant xp, count defeats, drop loot (unless noLoot) and bump violence counters', () => {
    const { w, s, p } = setup((x) => {
      x.rules = [{ id: 'r', name: 'R', description: 'd', switches: { violenceCounter: 'blood' } }];
    });
    const ctx = ctxFor(w, s);
    const a = addActor(w, s, 'archer', { x: 3, y: 3 });
    dealDamage(ctx, a, 100, 'physical', p.id);
    expect(s.player.xp).toBe(6);
    expect(s.defeated.archer).toBe(1);
    expect(s.counters.blood).toBe(1);
    expect(s.area.items.map((i) => i.item.defId)).toEqual(['tonic']);
    const nl = setup((x) => {
      x.rules = [{ id: 'r', name: 'R', description: 'd', switches: { noLoot: true } }];
    });
    const a2 = addActor(nl.w, nl.s, 'archer', { x: 3, y: 3 });
    dealDamage(ctxFor(nl.w, nl.s), a2, 100, 'physical', nl.p.id);
    expect(nl.s.area.items).toEqual([]);
  });

  it('attacking a friendly or neutral actor provokes it', () => {
    const { w, s, p } = setup();
    const sage = addActor(w, s, 'sage', { x: 2, y: 1 });
    performAttack(ctxFor(w, s, new ScriptedRng([10])), p, sage);
    expect(sage.faction).toBe('hostile');
  });

  it('player death ends the run; permadeathMercy saves once', () => {
    const { w, s, p } = setup();
    const ctx = ctxFor(w, s);
    dealDamage(ctx, p, 999, 'physical');
    expect(s.status).toBe('lost');
    expect(ctx.events.some((e) => e.type === 'game_over' && e.result === 'lost')).toBe(true);
    const m = setup((x) => {
      x.rules = [{ id: 'r', name: 'R', description: 'd', switches: { permadeathMercy: true } }];
    });
    const mctx = ctxFor(m.w, m.s);
    dealDamage(mctx, m.p, 999, 'physical');
    expect(m.s.status).toBe('playing');
    expect(m.p.hp).toBe(15);
    dealDamage(mctx, m.p, 999, 'physical');
    expect(m.s.status).toBe('lost');
  });

  it('durability: equipped weapons wear out and break', () => {
    const { w, s, p } = setup((x) => {
      x.rules = [{ id: 'r', name: 'R', description: 'd', switches: { durability: true } }];
    });
    const slot = s.player.equipped.weapon!;
    expect(s.player.slots[slot]!.durability).toBe(40);
    s.player.slots[slot]!.durability = 1;
    const g = addActor(w, s, 'rat', { x: 2, y: 1 }, { hp: 99, maxHp: 99 });
    performAttack(ctxFor(w, s, new ScriptedRng([19])), p, g);
    expect(s.player.slots[slot]).toBeNull();
    expect(s.player.equipped.weapon).toBeNull();
  });

  it('on_low_hp fires once per crossing (and the player gets a low_hp event)', () => {
    const { w, s, p } = setup((x) => {
      x.actors[0].triggers = [{ on: 'on_low_hp', action: { targeting: { shape: 'self', affects: 'self_only' }, effects: [{ type: 'counter', counter: 'low', add: 1 }] } }];
    });
    const ctx = ctxFor(w, s);
    const r = addActor(w, s, 'rat', { x: 5, y: 5 }, { hp: 10, maxHp: 10 });
    dealDamage(ctx, r, 8, 'physical', p.id);
    dealDamage(ctx, r, 1, 'physical', p.id);
    expect(s.counters.low).toBe(1);
    dealDamage(ctx, p, 25, 'physical', r.id);
    expect(ctx.events.filter((e) => e.type === 'low_hp')).toHaveLength(1);
  });
});

function waitN(w: ReturnType<typeof testWorld>, s: GameState, n: number): GameState {
  for (let i = 0; i < n; i++) s = act(w, s, { type: 'wait' }).state;
  return s;
}

describe('status flags', () => {
  it('stunned: the player loses turns', () => {
    const { w, s, p } = setup();
    applyStatus(ctxFor(w, s), p, 'stun', 3);
    const r = act(w, s, { type: 'wait' });
    expect(r.state.turn).toBeGreaterThanOrEqual(3);
    expect(r.state.log.some((l) => l.text.includes("can't act"))).toBe(true);
  });

  it('stunned monsters do nothing', () => {
    const { w, s, p } = setup();
    const r = addActor(w, s, 'rat', { x: 2, y: 1 }, { ai: { alerted: true } });
    applyStatus(ctxFor(w, s), r, 'stun', 50);
    const s2 = waitN(w, s, 10);
    expect(player(s2).hp).toBe(p.hp);
  });

  it('rooted: the player cannot move', () => {
    const { w, s, p } = setup();
    applyStatus(ctxFor(w, s), p, 'root', 3);
    expect(act(w, s, { type: 'move', dir: 'e' }).events[0]).toMatchObject({ type: 'invalid' });
  });

  it('afraid: the player cannot attack', () => {
    const { w, s, p } = setup();
    const r = addActor(w, s, 'rat', { x: 2, y: 1 });
    applyStatus(ctxFor(w, s), p, 'fear', 3);
    expect(act(w, s, { type: 'move', dir: 'e' }).events[0]).toMatchObject({ type: 'invalid', reason: 'too afraid to fight' });
    expect(act(w, s, { type: 'attack', targetId: r.id }).events[0]).toMatchObject({ type: 'invalid' });
  });

  it('afraid monsters flee', () => {
    const { w, s } = setup();
    const r = addActor(w, s, 'rat', { x: 3, y: 1 }, { ai: { alerted: true } });
    applyStatus(ctxFor(w, s), r, 'fear', 20);
    const s2 = waitN(w, s, 4);
    const r2 = s2.area.actors.find((a) => a.id === r.id)!;
    expect(Math.max(Math.abs(r2.pos.x - 1), Math.abs(r2.pos.y - 1))).toBeGreaterThan(2);
  });

  it('confused: some moves go astray', () => {
    const { w, s, p } = setup(undefined, roomMap(30, 30, { start: { x: 15, y: 15 }, exit: { x: 28, y: 28 } }));
    applyStatus(ctxFor(w, s), p, 'confuse', 200);
    let st = s;
    let astray = 0;
    for (let i = 0; i < 40; i++) {
      const before = { ...player(st).pos };
      st = act(w, st, { type: 'move', dir: i % 2 ? 'e' : 'w' }).state;
      const after = player(st).pos;
      if (after.y !== before.y) astray++;
    }
    expect(astray).toBeGreaterThan(3);
  });

  it('hasted / slowed change energy gain and turns per action', () => {
    const { w, s, p } = setup();
    const ctx = ctxFor(w, s);
    expect(energyGain(ctx, p)).toBe(100);
    applyStatus(ctx, p, 'haste', 10);
    expect(energyGain(ctx, p)).toBe(200);
    const h = waitN(w, s, 4);
    expect(h.turn).toBe(2);
    const o = setup();
    applyStatus(ctxFor(o.w, o.s), o.p, 'slow', 10);
    expect(act(o.w, o.s, { type: 'wait' }).state.turn).toBe(2);
  });

  it('invisible: monsters only notice when adjacent', () => {
    const { w, s, p } = setup();
    const r = addActor(w, s, 'rat', { x: 4, y: 1 });
    applyStatus(ctxFor(w, s), p, 'hide', 50);
    const s2 = act(w, s, { type: 'wait' }).state;
    expect(s2.area.actors.find((a) => a.id === r.id)!.ai.alerted).toBe(false);
    const v = setup();
    const r2 = addActor(v.w, v.s, 'rat', { x: 4, y: 1 });
    const v2 = act(v.w, v.s, { type: 'wait' }).state;
    expect(v2.area.actors.find((a) => a.id === r2.id)!.ai.alerted).toBe(true);
  });

  it('blinded: sight radius 1', () => {
    const { w, s, p } = setup();
    const ctx = ctxFor(w, s);
    applyStatus(ctx, p, 'blind', 5);
    expect(sightRadius(ctx, p)).toBe(1);
  });

  it('silenced: spells cannot be used', () => {
    const { w, s, p } = setup();
    const ctx = ctxFor(w, s);
    giveItem(ctx, 'spark', 1);
    applyStatus(ctx, p, 'mute', 5);
    addActor(w, s, 'rat', { x: 3, y: 1 });
    const slot = s.player.slots.findIndex((x) => x?.defId === 'spark');
    expect(act(w, s, { type: 'use', slot }).events[0]).toMatchObject({ type: 'invalid', reason: 'silenced' });
  });

  it('charmed monsters do not attack', () => {
    const { w, s, p } = setup();
    const r = addActor(w, s, 'rat', { x: 2, y: 1 }, { ai: { alerted: true } });
    applyStatus(ctxFor(w, s), r, 'charm', 100);
    const s2 = waitN(w, s, 15);
    expect(player(s2).hp).toBe(p.hp);
  });

  it('regenerating heals each turn; perTurn effects and modifiers apply', () => {
    const { w, s, p } = setup();
    const ctx = ctxFor(w, s);
    p.hp = 10;
    applyStatus(ctx, p, 'regen', 3);
    const s2 = waitN(w, s, 3);
    expect(player(s2).hp).toBe(13);
    const b = setup();
    applyStatus(ctxFor(b.w, b.s), b.p, 'burning', 2);
    const b2 = waitN(b.w, b.s, 3);
    expect(player(b2).hp).toBe(28);
    expect(player(b2).statuses).toEqual([]);
  });
});

describe('ai behaviours', () => {
  it('chasers close in and attack', () => {
    const { w, s, p } = setup();
    // within the rat's sight circle (sight is Euclidean like the player's field of view)
    addActor(w, s, 'rat', { x: 6, y: 5 });
    const s2 = waitN(w, s, 12);
    expect(player(s2).hp).toBeLessThan(p.hp);
  });

  it('stationary actors never move', () => {
    const { w, s } = setup();
    const g = addActor(w, s, 'golem', { x: 6, y: 6 }, { ai: { alerted: true } });
    const s2 = waitN(w, s, 10);
    expect(s2.area.actors.find((a) => a.id === g.id)!.pos).toEqual({ x: 6, y: 6 });
  });

  it('kiters keep their distance and shoot', () => {
    const { w, s, p } = setup(undefined, roomMap(20, 12));
    const a = addActor(w, s, 'archer', { x: 3, y: 2 }, { mp: 0 });
    const s2 = waitN(w, s, 6);
    const a2 = s2.area.actors.find((x) => x.id === a.id)!;
    expect(Math.max(Math.abs(a2.pos.x - 1), Math.abs(a2.pos.y - 1))).toBeGreaterThanOrEqual(2);
    expect(s2.log.some((l) => l.text.startsWith('Archer shoots'))).toBe(true);
    void p;
  });

  it('monsters use abilities (paying cost, starting cooldown)', () => {
    const { w, s } = setup();
    const a = addActor(w, s, 'archer', { x: 4, y: 1 });
    const s2 = waitN(w, s, 8);
    const a2 = s2.area.actors.find((x) => x.id === a.id);
    expect(s2.log.some((l) => l.text === 'Archer uses Fire Bolt.')).toBe(true);
    if (a2) expect(a2.mp).toBeLessThan(10);
  });

  it('friendly / neutral actors do not attack unless provoked', () => {
    const { w, s, p } = setup((x) => {
      x.actors[0].faction = 'neutral';
    });
    addActor(w, s, 'rat', { x: 2, y: 1 });
    const s2 = waitN(w, s, 10);
    expect(player(s2).hp).toBe(p.hp);
  });

  it('allies follow the player and fight hostiles', () => {
    const { w, s } = setup(undefined, roomMap(20, 10));
    const ally = addActor(w, s, 'rat', { x: 2, y: 2 }, { allyOf: 'a1', faction: 'friendly', hp: 99, maxHp: 99 });
    let st = s;
    for (let i = 0; i < 8; i++) st = act(w, st, { type: 'move', dir: 'e' }).state;
    const a2 = st.area.actors.find((x) => x.id === ally.id)!;
    expect(Math.max(Math.abs(a2.pos.x - player(st).pos.x), Math.abs(a2.pos.y - player(st).pos.y))).toBeLessThanOrEqual(3);
    const foe = addActor(w, st, 'rat', { x: a2.pos.x, y: a2.pos.y + 2 });
    st = waitN(w, st, 6);
    expect(st.area.actors.find((x) => x.id === foe.id)?.hp ?? 0).toBeLessThan(5);
  });

  it('guardians return home when nothing is near', () => {
    const { w, s } = setup((x) => {
      x.actors[0].behaviour = { type: 'guardian', param: 2 };
    }, roomMap(20, 10));
    const g = addActor(w, s, 'rat', { x: 15, y: 5 }, { ai: { alerted: false, home: { x: 15, y: 7 } } });
    const s2 = waitN(w, s, 4);
    expect(s2.area.actors.find((x) => x.id === g.id)!.pos).toEqual({ x: 15, y: 7 });
  });

  it('ambushers wait until the player is close', () => {
    const { w, s } = setup((x) => {
      x.actors[0].behaviour = { type: 'ambusher', param: 2 };
    }, roomMap(20, 10));
    const g = addActor(w, s, 'rat', { x: 6, y: 1 });
    const s2 = waitN(w, s, 3);
    expect(s2.area.actors.find((x) => x.id === g.id)!.pos).toEqual({ x: 6, y: 1 });
  });
});

describe('ai edge cases', () => {
  it('a kiter with only a melee attack closes in instead of dancing away', () => {
    const { w, s, p } = setup((x) => {
      x.actors[0].behaviour = { type: 'kiter', param: 4 };
    });
    addActor(w, s, 'rat', { x: 3, y: 1 }, { ai: { alerted: true } });
    const s2 = waitN(w, s, 8);
    expect(player(s2).hp).toBeLessThan(p.hp);
  });

  it('a very long stun resolves within one step', () => {
    const { w, s, p } = setup();
    applyStatus(ctxFor(w, s), p, 'stun', 200);
    const r = act(w, s, { type: 'wait' });
    expect(r.state.turn).toBeGreaterThanOrEqual(200);
    expect(player(r.state).statuses).toEqual([]);
  });
});
