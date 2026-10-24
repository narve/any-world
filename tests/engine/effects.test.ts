import { describe, it, expect } from 'vitest';
import type { Action, Effect, Targeting } from '../../src/schema';
import { testWorld, newGame, ctxFor, player, addActor, roomMap } from './helpers';
import { runAction, applyEffectList, resolveTargets } from '../../src/engine/effects';
import { sightRadius } from '../../src/engine/stats';
import { endRound } from '../../src/engine/turn';
import { knowledgeOf } from '../../src/engine/knowledge';
import { giveItem } from '../../src/engine/inventory';
import { updateFov } from '../../src/engine/vision';

const T = (t: Partial<Targeting>): Targeting => ({ shape: 'self', range: 1, radius: 0, affects: 'enemies', needsLos: true, ...t });
const A = (t: Partial<Targeting>, effects: Effect[]): Action => ({ targeting: T(t), effects });
const SELF = { shape: 'self', affects: 'self_only' } as const;

function setup(map = roomMap()) {
  const w = testWorld();
  const s = newGame(w, 1, map);
  const ctx = ctxFor(w, s);
  const p = player(s);
  return { w, s, ctx, p };
}

describe('effects', () => {
  it('damage applies resistances (immune, halved) and records killer', () => {
    const { w, s, ctx, p } = setup();
    const g = addActor(w, s, 'golem', { x: 2, y: 1 });
    runAction(ctx, A({ shape: 'single', range: 1 }, [{ type: 'damage', amount: { base: 10 }, damageType: 'fire' }]), p, { targetPos: g.pos });
    expect(g.hp).toBe(40);
    runAction(ctx, A({ shape: 'single', range: 1 }, [{ type: 'damage', amount: { base: 10 }, damageType: 'physical' }]), p, { targetPos: g.pos });
    expect(g.hp).toBe(35);
    const r = addActor(w, s, 'rat', { x: 1, y: 2 });
    runAction(ctx, A({ shape: 'single', range: 1 }, [{ type: 'damage', amount: { base: 99 }, damageType: 'physical' }]), p, { targetPos: r.pos });
    expect(s.area.actors.includes(r)).toBe(false);
    expect(s.defeated.rat).toBe(1);
    expect(s.stats.kills).toBe(1);
    expect(ctx.events.some((e) => e.type === 'died' && e.killerId === p.id)).toBe(true);
  });

  it('heal is capped at max hp', () => {
    const { ctx, p } = setup();
    p.hp = 10;
    applyEffectList(ctx, [{ type: 'heal', amount: { base: 6 } }], p, [p], p.pos, []);
    expect(p.hp).toBe(16);
    applyEffectList(ctx, [{ type: 'heal', amount: { base: 600 } }], p, [p], p.pos, []);
    expect(p.hp).toBe(30);
  });

  it('resource: mp, custom (clamped, onEmpty + trigger), hp', () => {
    const { s, ctx, p } = setup();
    applyEffectList(ctx, [{ type: 'resource', resource: 'mp', amount: { base: -4 } }], p, [p], p.pos, []);
    expect(p.mp).toBe(6);
    applyEffectList(ctx, [{ type: 'resource', resource: 'oil', amount: { base: 50 } }], p, [p], p.pos, []);
    expect(s.player.resources.oil).toBe(20);
    applyEffectList(ctx, [{ type: 'resource', resource: 'oil', amount: { base: -50 } }], p, [p], p.pos, []);
    expect(s.player.resources.oil).toBe(0);
    expect(p.statuses.map((x) => x.id)).toContain('blind'); // onEmpty
    applyEffectList(ctx, [{ type: 'resource', resource: 'hp', amount: { base: -5 } }], p, [p], p.pos, []);
    expect(p.hp).toBe(25);
  });

  it('modify_stat: permanent and temporary', () => {
    const { s, ctx, p } = setup();
    applyEffectList(ctx, [{ type: 'modify_stat', stat: 'str', amount: 2 }], p, [p], p.pos, []);
    expect(p.base.str).toBe(14);
    applyEffectList(ctx, [{ type: 'modify_stat', stat: 'dex', amount: 3, duration: 2 }], p, [p], p.pos, []);
    expect(p.tempMods).toEqual([{ stat: 'dex', amount: 3, turnsLeft: 2 }]);
    endRound(ctx);
    expect(p.tempMods).toHaveLength(1);
    endRound(ctx);
    expect(p.tempMods).toHaveLength(0);
    applyEffectList(ctx, [{ type: 'modify_stat', stat: 'hp', amount: 5 }], p, [p], p.pos, []);
    expect(p.maxHp).toBe(35);
    void s;
  });

  it('apply_status refreshes, remove_status (one / all_harmful)', () => {
    const { ctx, p } = setup();
    applyEffectList(ctx, [{ type: 'apply_status', status: 'burning', duration: 3 }], p, [p], p.pos, []);
    applyEffectList(ctx, [{ type: 'apply_status', status: 'burning', duration: 5 }], p, [p], p.pos, []);
    expect(p.statuses).toEqual([{ id: 'burning', turnsLeft: 5 }]);
    applyEffectList(ctx, [{ type: 'apply_status', status: 'haste', duration: 5 }, { type: 'apply_status', status: 'root', duration: 5 }], p, [p], p.pos, []);
    applyEffectList(ctx, [{ type: 'remove_status', status: 'all_harmful' }], p, [p], p.pos, []);
    expect(p.statuses.map((x) => x.id)).toEqual(['haste']);
    applyEffectList(ctx, [{ type: 'remove_status', status: 'haste' }], p, [p], p.pos, []);
    expect(p.statuses).toEqual([]);
  });

  it('teleport: random, to_exit, swap, to_target', () => {
    const { w, s, ctx, p } = setup();
    applyEffectList(ctx, [{ type: 'teleport', mode: 'random' }], p, [p], p.pos, []);
    expect(Math.max(Math.abs(p.pos.x - 1), Math.abs(p.pos.y - 1))).toBeGreaterThanOrEqual(2);
    applyEffectList(ctx, [{ type: 'teleport', mode: 'to_exit' }], p, [p], p.pos, []);
    expect(Math.max(Math.abs(p.pos.x - s.area.map.exit.x), Math.abs(p.pos.y - s.area.map.exit.y))).toBeLessThanOrEqual(1);
    const r = addActor(w, s, 'rat', { x: 2, y: 2 });
    const before = { ...p.pos };
    runAction(ctx, A({ shape: 'single', range: 20, needsLos: false }, [{ type: 'teleport', mode: 'swap' }]), p, { targetPos: r.pos });
    expect(p.pos).toEqual({ x: 2, y: 2 });
    expect(r.pos).toEqual(before);
    runAction(ctx, A({ shape: 'area', range: 10, radius: 0, affects: 'self_only' }, [{ type: 'teleport', mode: 'to_target' }]), p, { targetPos: { x: 5, y: 5 } });
    expect(p.pos).toEqual({ x: 5, y: 5 });
  });

  it('push and pull stop at walls/adjacency', () => {
    const { w, s, ctx, p } = setup();
    const r = addActor(w, s, 'rat', { x: 2, y: 1 });
    runAction(ctx, A({ shape: 'single', range: 1 }, [{ type: 'push', distance: 3 }]), p, { targetPos: r.pos });
    expect(r.pos).toEqual({ x: 5, y: 1 });
    runAction(ctx, A({ shape: 'single', range: 10 }, [{ type: 'push', distance: 6 }]), p, { targetPos: r.pos });
    expect(r.pos).toEqual({ x: 10, y: 1 }); // wall at x=11
    runAction(ctx, A({ shape: 'single', range: 10 }, [{ type: 'pull', distance: 6 }]), p, { targetPos: r.pos });
    expect(r.pos).toEqual({ x: 4, y: 1 });
    runAction(ctx, A({ shape: 'single', range: 10 }, [{ type: 'pull', distance: 6 }]), p, { targetPos: r.pos });
    expect(r.pos).toEqual({ x: 2, y: 1 });
  });

  it('summon: allied for the player side, hostile otherwise', () => {
    const { w, s, ctx, p } = setup();
    applyEffectList(ctx, [{ type: 'summon', actor: 'rat', count: 2, allied: true }], p, [], p.pos, []);
    const allies = s.area.actors.filter((a) => a.defId === 'rat');
    expect(allies).toHaveLength(2);
    for (const a of allies) expect(a.allyOf).toBe(p.id);
    const arch = addActor(w, s, 'archer', { x: 8, y: 8 }, { faction: 'hostile' });
    applyEffectList(ctx, [{ type: 'summon', actor: 'rat', count: 1, allied: true }], arch, [], arch.pos, []);
    const enemy = s.area.actors.filter((a) => a.defId === 'rat' && !a.allyOf);
    expect(enemy).toHaveLength(1);
    expect(enemy[0].faction).toBe('hostile');
    // unique actors only once per run
    applyEffectList(ctx, [{ type: 'summon', actor: 'boss', count: 2, allied: false }], arch, [], arch.pos, []);
    expect(s.area.actors.filter((a) => a.defId === 'boss')).toHaveLength(1);
  });

  it('spawn_terrain with duration expires; blocking terrain never cuts off the exit', () => {
    const { s, ctx, p } = setup();
    applyEffectList(ctx, [{ type: 'spawn_terrain', terrain: 'spikes', radius: 1, duration: 2 }], p, [], { x: 5, y: 5 }, []);
    const map = s.area.map;
    expect(map.tiles[5 * map.width + 5].terrain).toBe('spikes');
    expect(map.tiles[4 * map.width + 4].terrain).toBe('spikes');
    endRound(ctx);
    endRound(ctx);
    expect(map.tiles[5 * map.width + 5].terrain).toBeUndefined();
    // corridor: a blocking pillar across it would disconnect the exit → refused
    const corridor = roomMap(8, 3, { start: { x: 1, y: 1 }, exit: { x: 6, y: 1 } });
    const k = setup(corridor);
    applyEffectList(k.ctx, [{ type: 'spawn_terrain', terrain: 'pillar', radius: 0 }], k.p, [], { x: 4, y: 1 }, []);
    expect(k.s.area.map.tiles[1 * 8 + 4].terrain).toBeUndefined();
    applyEffectList(ctx, [{ type: 'spawn_terrain', terrain: 'pillar', radius: 0 }], p, [], { x: 6, y: 6 }, []);
    expect(map.tiles[6 * map.width + 6].terrain).toBe('pillar');
  });

  it('spawn_item, reveal_map, identify, light, noise, grant_xp, flags, counters, message', () => {
    const { w, s, ctx, p } = setup();
    applyEffectList(ctx, [{ type: 'spawn_item', item: 'tonic', count: 3 }], p, [], { x: 4, y: 4 }, []);
    expect(s.area.items).toEqual([{ item: expect.objectContaining({ defId: 'tonic', count: 3 }), pos: { x: 4, y: 4 } }]);
    s.area.seen.fill(0);
    applyEffectList(ctx, [{ type: 'reveal_map', radius: 99 }], p, [], p.pos, []);
    expect([...s.area.seen].every((v) => v >= 1)).toBe(true);
    giveItem(ctx, 'murk', 1);
    giveItem(ctx, 'fog', 1);
    applyEffectList(ctx, [{ type: 'identify', scope: 'one' }], p, [], p.pos, []);
    expect([knowledgeOf(ctx, 'murk').level, knowledgeOf(ctx, 'fog').level].filter((l) => l === 'clear')).toHaveLength(1);
    applyEffectList(ctx, [{ type: 'identify', scope: 'all_carried' }], p, [], p.pos, []);
    expect(knowledgeOf(ctx, 'fog').level).toBe('clear');
    const base = sightRadius(ctx, p);
    applyEffectList(ctx, [{ type: 'light', radius: 10, duration: 3 }], p, [p], p.pos, []);
    expect(sightRadius(ctx, p)).toBe(Math.max(base, 10));
    const r = addActor(w, s, 'rat', { x: 9, y: 8 });
    applyEffectList(ctx, [{ type: 'noise', radius: 3 }], p, [], { x: 8, y: 8 }, []);
    expect(r.ai.alerted).toBe(true);
    expect(r.ai.lastSeen).toEqual({ x: 8, y: 8 });
    applyEffectList(ctx, [{ type: 'grant_xp', amount: 12 }], p, [], p.pos, []);
    expect(s.player.level).toBe(2);
    expect(s.player.pendingPerkChoice).toHaveLength(3);
    applyEffectList(ctx, [{ type: 'set_flag', flag: 'x', value: true }, { type: 'counter', counter: 'c', add: 2 }, { type: 'counter', counter: 'c', add: 1 }, { type: 'message', text: 'Hello there' }], p, [], p.pos, []);
    expect(s.flags.x).toBe(true);
    expect(s.counters.c).toBe(3);
    expect(s.log.some((l) => l.text === 'Hello there')).toBe(true);
  });

  it('transform and change_faction', () => {
    const { w, s, ctx, p } = setup();
    const r = addActor(w, s, 'rat', { x: 3, y: 3 });
    runAction(ctx, A({ shape: 'single', range: 5 }, [{ type: 'transform', into: 'golem' }]), p, { targetPos: r.pos });
    expect(r.defId).toBe('golem');
    expect(r.maxHp).toBe(40);
    runAction(ctx, A({ shape: 'single', range: 5, affects: 'all' }, [{ type: 'change_faction', faction: 'friendly' }]), p, { targetPos: r.pos });
    expect(r.faction).toBe('friendly');
    // the player can't be transformed
    applyEffectList(ctx, [{ type: 'transform', into: 'rat' }], p, [p], p.pos, []);
    expect(p.defId).toBe('player');
  });

  it('a failed condition applies nothing', () => {
    const { ctx, p } = setup();
    p.hp = 10;
    const res = runAction(ctx, { ...A(SELF, [{ type: 'heal', amount: { base: 5 } }]), condition: { type: 'flag', flag: 'nope' } }, p);
    expect(res.conditionFailed).toBe(true);
    expect(p.hp).toBe(10);
  });
});

describe('targeting', () => {
  it('single: range and line of sight', () => {
    const map = roomMap(12, 10, { walls: [{ x: 3, y: 1 }] });
    const { w, s, ctx, p } = setup(map);
    const r = addActor(w, s, 'rat', { x: 5, y: 1 });
    expect(resolveTargets(ctx, p, T({ shape: 'single', range: 3 }), r.pos)).toMatchObject({ ok: false, reason: 'target out of range' });
    expect(resolveTargets(ctx, p, T({ shape: 'single', range: 6 }), r.pos)).toMatchObject({ ok: false, reason: 'no line of sight' });
    expect(resolveTargets(ctx, p, T({ shape: 'single', range: 6, needsLos: false }), r.pos)).toMatchObject({ ok: true, actors: [r] });
  });

  it('ray hits everything on the line and stops at walls', () => {
    const map = roomMap(12, 10, { walls: [{ x: 6, y: 1 }] });
    const { w, s, ctx, p } = setup(map);
    const a = addActor(w, s, 'rat', { x: 3, y: 1 });
    const b = addActor(w, s, 'rat', { x: 5, y: 1 });
    const c = addActor(w, s, 'rat', { x: 7, y: 1 });
    const res = resolveTargets(ctx, p, T({ shape: 'ray', range: 10 }), { x: 2, y: 1 });
    expect(res.ok && res.actors).toEqual([a, b]);
    void c;
  });

  it('cone covers the front, not the back', () => {
    const { w, s, ctx, p } = setup();
    p.pos = { x: 5, y: 5 };
    const front = addActor(w, s, 'rat', { x: 7, y: 5 });
    const diag = addActor(w, s, 'rat', { x: 7, y: 6 });
    const back = addActor(w, s, 'rat', { x: 3, y: 5 });
    const res = resolveTargets(ctx, p, T({ shape: 'cone', radius: 3 }), { x: 6, y: 5 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.actors).toContain(front);
      expect(res.actors).toContain(diag);
      expect(res.actors).not.toContain(back);
    }
  });

  it('area: radius around the centre; affects filters (enemies / all / allies)', () => {
    const { w, s, ctx, p } = setup();
    p.pos = { x: 5, y: 5 };
    const r1 = addActor(w, s, 'rat', { x: 7, y: 5 });
    const r2 = addActor(w, s, 'rat', { x: 8, y: 6 });
    const far = addActor(w, s, 'rat', { x: 10, y: 8 });
    const res = resolveTargets(ctx, p, T({ shape: 'area', range: 5, radius: 1 }), { x: 7, y: 6 });
    expect(res.ok && res.actors.sort((a, b) => a.id.localeCompare(b.id))).toEqual([r1, r2]);
    void far;
    const all = resolveTargets(ctx, p, T({ shape: 'area', range: 5, radius: 2, affects: 'all' }), { x: 6, y: 5 });
    expect(all.ok && all.actors).toContain(p);
    const enemies = resolveTargets(ctx, p, T({ shape: 'area', range: 5, radius: 2 }), { x: 6, y: 5 });
    expect(enemies.ok && enemies.actors).not.toContain(p);
    const allies = resolveTargets(ctx, p, T({ shape: 'area', range: 5, radius: 2, affects: 'allies' }), { x: 6, y: 5 });
    expect(allies.ok && allies.actors).toEqual([p]);
    expect(resolveTargets(ctx, p, T({ shape: 'area', range: 1, radius: 2 }), { x: 9, y: 5 })).toMatchObject({ ok: false });
  });

  it('adjacent and all_visible', () => {
    const { w, s, ctx, p } = setup();
    p.pos = { x: 5, y: 5 };
    const near = addActor(w, s, 'rat', { x: 6, y: 6 });
    const far = addActor(w, s, 'rat', { x: 9, y: 5 });
    updateFov(ctx);
    const adj = resolveTargets(ctx, p, T({ shape: 'adjacent' }));
    expect(adj.ok && adj.actors).toEqual([near]);
    const vis = resolveTargets(ctx, p, T({ shape: 'all_visible', range: 8, needsLos: true }));
    expect(vis.ok && vis.actors).toEqual([near, far]);
  });

  it('auto-targets the nearest valid enemy when no position is given', () => {
    const { w, s, ctx, p } = setup();
    addActor(w, s, 'rat', { x: 6, y: 1 });
    const near = addActor(w, s, 'rat', { x: 3, y: 1 });
    const res = runAction(ctx, A({ shape: 'single', range: 8 }, [{ type: 'damage', amount: { base: 1 }, damageType: 'physical' }]), p);
    expect(res.ok).toBe(true);
    expect(near.hp).toBe(4);
    const none = runAction(ctx, A({ shape: 'single', range: 1 }, [{ type: 'damage', amount: { base: 1 }, damageType: 'physical' }]), p);
    expect(none).toMatchObject({ ok: false, reason: 'no target in range' });
  });
});
