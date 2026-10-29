/**
 * MP2 C1: the offline GM moved to src/gm/offline.ts (shared by the client and the room server).
 * Offer labels come through an injected `t` (English without one); the client's re-exported
 * director labels them with the client's i18n, so its answers are unchanged.
 *
 * MP4 G1: per-player hooks and party throttles (MP4 design §2.2). A party of one derives exactly
 * the hooks it did before (hashes taken with the MP3 code); a party of 2+ names the subject and is
 * throttled.
 */
import { describe, it, expect } from 'vitest';
import { addPlayer, createGame, step } from '../../src/engine';
import type { GameEvent, GameState, PlayerId } from '../../src/engine/types';
import type { GmAction, GmResponse } from '../../src/schema/gm';
import {
  OfflineGmDirector,
  PARTY_LOW_HP_TURNS,
  PARTY_REGION_TURNS,
  cloneTracker,
  gmHooksFor,
  newHookTracker,
  type GmContext,
  type GmHookEvent,
  type GmTranslate,
  type HookTracker,
} from '../../src/gm/offline';
import * as client from '../../src/client/gm-director';
import { botByName, newMemory } from '../../src/engine/sim/bots';
import { fnv1a64 } from '../../src/llm/hash';
import { loadFixture, roomMap } from '../engine/helpers';

const ship = loadFixture('fixture-ship.json');

function ctx(seed: number): GmContext {
  const state: GameState = createGame(ship, { seed, map: roomMap(16, 12) });
  return { world: ship, state, difficulty: 'normal', weirdness: 0.3, recentLog: [], areaEnteredTurn: 0 };
}

const offerOf = (r: GmResponse | null) => r?.actions.find((a): a is Extract<GmAction, { type: 'offer_choice' }> => a.type === 'offer_choice');

/** the first seed whose area-0 event is an offer */
function offerSeed(): number {
  const d = new OfflineGmDirector({ eventDelay: 0 });
  for (let seed = 1; seed < 200; seed++) if (offerOf(d.respondSync({ hook: 'idle', area: 0, turn: 30, ctx: ctx(seed) }))) return seed;
  throw new Error('no seed with an offer');
}

describe('src/gm/offline', () => {
  const seed = offerSeed();
  const ask = (d: OfflineGmDirector) => offerOf(d.respondSync({ hook: 'idle', area: 0, turn: 30, ctx: ctx(seed) }))!;

  it('labels offers in English without a catalog, and through an injected t', () => {
    const en = ask(new OfflineGmDirector({ eventDelay: 0 }));
    expect(en.options[0].label).toMatch(/^Take the /);
    expect(en.options[1].label).toBe('Leave it be');
    const keys: string[] = [];
    const t: GmTranslate = (key, params) => {
      keys.push(key);
      return `[${key}${params?.item ? `:${params.item}` : ''}]`;
    };
    const mine = ask(new OfflineGmDirector({ eventDelay: 0, t }));
    expect(keys).toEqual(['gm.offer.take', 'gm.offer.leave']);
    expect(mine.options[0].label).toBe(`[gm.offer.take:${en.options[0].label.replace(/^Take the /, '')}]`);
    // only the labels differ
    expect(mine.options.map((o) => o.actions)).toEqual(en.options.map((o) => o.actions));
  });

  it('the client re-exports the same names, its director labelled by the client i18n', () => {
    expect(client.gmHooksFor).toBeTypeOf('function');
    expect(client.sanitizeResponse).toBeTypeOf('function');
    const d = new client.OfflineGmDirector({ eventDelay: 0 });
    expect(d).toBeInstanceOf(OfflineGmDirector);
    expect(ask(d)).toEqual(ask(new OfflineGmDirector({ eventDelay: 0 })));
  });
});

/** a seeded bot run: every hook gmHooksFor derives, and the tracker at the end */
function botRun(file: string, seed: number, bot: string): { hooks: GmHookEvent[]; tracker: HookTracker } {
  const world = loadFixture(file);
  let s = createGame(world, { seed });
  const tracker = newHookTracker(s.turn);
  const mem = newMemory(seed);
  const b = botByName(bot);
  const hooks: GmHookEvent[] = [];
  for (let i = 0; i < 1500 && s.status === 'playing'; i++) {
    const r = step(s, b.decide(s, world, mem), { world });
    hooks.push(...gmHooksFor(world, s, r.state, r.events, tracker));
    s = r.state;
  }
  return { hooks, tracker };
}

describe('hooks for a party of one (unchanged by MP4)', () => {
  // fnv1a64(JSON.stringify([hooks, tracker])) with the MP3 code (src/gm/offline.ts before G1)
  const MP3 = [
    ['fixture-ship.json', 3, 'explorer', '76aef77da73259da'],
    ['fixture-western.json', 7, 'cautious', '9106745f5a29420c'],
    ['fixture-teen.json', 2, 'explorer', 'ec8aec1fee6f314a'],
    ['fixture-dream.json', 4, 'random', '8d6cde74bba14cbf'],
  ] as const;
  it.each(MP3)('%s seed %i (%s): the same hooks and tracker as before', (file, seed, bot, hash) => {
    const r = botRun(file, seed, bot);
    expect(r.hooks.length).toBeGreaterThan(2);
    expect(r.hooks.every((h) => h.detail?.playerId === undefined)).toBe(true);
    expect(Object.keys(r.tracker).sort()).toEqual(['areaEnteredTurn', 'bossesSeen', 'lastHookTurn']);
    expect(fnv1a64(JSON.stringify([r.hooks, r.tracker]))).toBe(hash);
  });
});

describe('party hooks and throttles (MP4 design §2.2)', () => {
  const ship = loadFixture('fixture-ship.json');

  function party(n: number): GameState {
    let s = createGame(ship, { seed: 11, map: roomMap(16, 12) });
    for (let i = 1; i < n; i++) s = addPlayer(s, { name: `P${i + 1}` }, { world: ship }).state;
    return s;
  }
  /** `s` some turns later, with `edit` applied to a copy */
  function later(s: GameState, turns: number, edit: (x: GameState) => void = () => undefined): GameState {
    const x = structuredClone(s);
    x.turn += turns;
    edit(x);
    return x;
  }
  const actorOf = (s: GameState, pid: PlayerId) => s.area.actors.find((a) => a.id === s.players[pid]!.actorId)!;
  const lowHp = (pid: PlayerId) => (x: GameState) => {
    actorOf(x, pid).ai.lowHp = true;
  };
  const hooksOf = (before: GameState, after: GameState, tracker: HookTracker, events: GameEvent[] = [], world = ship) => gmHooksFor(world, before, after, events, tracker).filter((h) => h.hook !== 'idle');

  it('low_hp names the player, once per player per area and once per party per 12 turns', () => {
    const s0 = party(3);
    const [p1, p2, p3] = s0.party as [PlayerId, PlayerId, PlayerId];
    const t = newHookTracker(s0.turn);
    const s1 = later(s0, 1, lowHp(p2));
    expect(hooksOf(s0, s1, t)).toEqual([{ hook: 'low_hp', area: 0, turn: s1.turn, detail: { playerId: p2 } }]);
    // p3 a few turns later: the party throttle holds
    const s2 = later(s1, 3, lowHp(p3));
    expect(hooksOf(s1, s2, t)).toEqual([]);
    // p2 recovers and drops again past the party throttle: once per player per area
    const s3 = later(s2, PARTY_LOW_HP_TURNS, (x) => (actorOf(x, p2).ai.lowHp = false));
    const s4 = later(s3, 1, lowHp(p2));
    expect(hooksOf(s3, s4, t)).toEqual([]);
    // p1 goes down (downed event) past the throttle: its own hook, reason downed
    const s5 = later(s4, PARTY_LOW_HP_TURNS);
    const h = hooksOf(s4, s5, t, [{ type: 'downed', playerId: p1, actorId: s0.players[p1]!.actorId }]);
    expect(h).toEqual([{ hook: 'low_hp', area: 0, turn: s5.turn, detail: { playerId: p1, reason: 'downed' } }]);
    expect(t.lowHpAt).toEqual({ [p2]: 0, [p1]: 0 });
    expect(t.lastLowHpTurn).toBe(s5.turn);
  });

  it('region_discovered at most once per 10 turns for the party', () => {
    const s0 = party(2);
    const t = newHookTracker(s0.turn);
    const ev = (id: number): GameEvent => ({ type: 'region_discovered', regionId: id });
    const s1 = later(s0, 1);
    expect(hooksOf(s0, s1, t, [ev(1), ev(2)]).map((x) => x.hook)).toEqual(['region_discovered']);
    const s2 = later(s1, PARTY_REGION_TURNS - 1);
    expect(hooksOf(s1, s2, t, [ev(3)])).toEqual([]);
    const s3 = later(s2, 1);
    expect(hooksOf(s2, s3, t, [ev(3)])).toEqual([{ hook: 'region_discovered', area: 0, turn: s3.turn, detail: { regionId: 3 } }]);
    expect(t.lastRegionTurn).toBe(s3.turn);
  });

  it('a shared level-up is one party milestone; a unique defeated names the player who killed it', () => {
    const s0 = party(3);
    const [, p2] = s0.party as [PlayerId, PlayerId];
    const t = newHookTracker(s0.turn);
    const s1 = later(s0, 1);
    const ups: GameEvent[] = s0.party.map(() => ({ type: 'level_up', level: 2, choices: [] }));
    expect(hooksOf(s0, s1, t, ups)).toEqual([{ hook: 'milestone', area: 0, turn: s1.turn, detail: { level: 2, reason: 'party_level_up' } }]);
    const killed: GameEvent = { type: 'died', actorId: 'a99', defId: 'warden-ostrova', killerId: s0.players[p2]!.actorId };
    expect(hooksOf(s0, s1, t, [killed])).toEqual([{ hook: 'milestone', area: 0, turn: s1.turn, detail: { actorId: 'a99', reason: 'unique_defeated', playerId: p2 } }]);
  });

  it('area_enter names the player whose exit countdown moved the party on', () => {
    const s0 = party(2);
    const [, p2] = s0.party as [PlayerId, PlayerId];
    const before = later(s0, 0, (x) => (x.area.exitCountdown = { turnsLeft: 0, by: p2 }));
    const after = later(s0, 1, (x) => (x.area.index = 1));
    expect(hooksOf(before, after, newHookTracker(s0.turn), [{ type: 'area_entered', index: 1 }])).toEqual([{ hook: 'area_enter', area: 1, turn: after.turn, detail: { playerId: p2 } }]);
  });

  it('boss_seen comes from the first member who sees the boss, once', () => {
    // the fixtures' uniques are all NPCs; make one a plain boss
    const world = { ...ship, actors: ship.actors.map((a) => (a.id === 'warden-ostrova' ? { ...a, npc: undefined } : a)) };
    const s0 = party(2);
    const [p1, p2] = s0.party as [PlayerId, PlayerId];
    const boss = { ...structuredClone(actorOf(s0, p1)), id: 'a77', defId: 'warden-ostrova', faction: 'hostile' as const, pos: { x: 14, y: 10 } };
    const t = newHookTracker(s0.turn);
    const s1 = later(s0, 1, (x) => {
      x.area.actors.push(boss);
      const w = x.area.map.width;
      x.players[p1]!.seen = Array.from(x.players[p1]!.seen, () => 0);
      const seen = Array.from(x.players[p2]!.seen, () => 0);
      seen[boss.pos.y * w + boss.pos.x] = 2;
      x.players[p2]!.seen = seen;
    });
    expect(hooksOf(s0, s1, t, [], world)).toEqual([{ hook: 'boss_seen', area: 0, turn: s1.turn, detail: { actorId: 'a77', playerId: p2 } }]);
    expect(hooksOf(s1, later(s1, 1), t, [], world)).toEqual([]);
  });

  it('a party of one keeps the unthrottled single-player rules (low_hp from the engine event)', () => {
    const s0 = party(1);
    const t = newHookTracker(s0.turn);
    const s1 = later(s0, 1);
    expect(hooksOf(s0, s1, t, [{ type: 'low_hp' }])).toEqual([{ hook: 'low_hp', area: 0, turn: s1.turn }]);
    expect(hooksOf(s1, later(s1, 1), t, [{ type: 'low_hp' }])).toHaveLength(1);
    expect(t.lowHpAt).toBeUndefined();
  });

  it('cloneTracker shares nothing with the live tracker', () => {
    const t: HookTracker = { ...newHookTracker(0), bossesSeen: ['a1'], lowHpAt: { p1: 0 }, lastLowHpTurn: 3 };
    const c = cloneTracker(t);
    expect(c).toEqual(t);
    t.bossesSeen.push('a2');
    t.lowHpAt!.p2 = 1;
    expect(c.bossesSeen).toEqual(['a1']);
    expect(c.lowHpAt).toEqual({ p1: 0 });
  });

  it('the offline director has nothing to say to the room-only chat hook', () => {
    const d = new OfflineGmDirector({ eventDelay: 0 });
    expect(d.respondSync({ hook: 'chat', area: 0, turn: 30, ctx: ctx(1) })).toBeNull();
  });
});
