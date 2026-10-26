/**
 * Live GM wiring (DESIGN §4.3, audit "Wire GM into play"): hooks from play reach a director, its
 * answers are applied between turns through GameSession.applyGm (engine applyGmActions), the
 * offline director narrates arrivals and runs exactly one budgeted event per area, and a slow or
 * failing provider never breaks play.
 */
import { describe, it, expect } from 'vitest';
import type { GameState } from '../../src/engine/types';
import type { GmResponse } from '../../src/schema/gm';
import { GM_BUDGET_PER_AREA } from '../../src/schema/gm';
import { GameSession } from '../../src/client/session';
import {
  GmRunner,
  OfflineGmDirector,
  eventFlag,
  gmHooksFor,
  newHookTracker,
  responseCost,
  sanitizeResponse,
  type GmDirector,
  type GmResult,
} from '../../src/client/gm-director';
import { loadFixture, roomMap } from '../engine/helpers';
import { leadPlayer } from '../../src/engine';

const western = loadFixture('fixture-western.json');
const ship = loadFixture('fixture-ship.json');

function session(world = western, seed = 1) {
  return new GameSession({ world, worldId: 'fixture-test', seed, map: roomMap(16, 12) });
}

/** what the browser controller does, synchronously: hooks → offline director → applyGm */
function pump(s: GameSession, d = new OfflineGmDirector()): { hook: string; response: GmResponse | null }[] {
  const seen: { hook: string; response: GmResponse | null }[] = [];
  for (let guard = 0; guard < 10; guard++) {
    const hooks = s.takeHooks();
    if (!hooks.length) break;
    for (const h of hooks) {
      const response = d.respondSync({ ...h, ctx: s.gmContext() });
      seen.push({ hook: h.hook, response });
      if (response) s.applyGm(response.actions, { hook: h.hook, area: h.area });
    }
  }
  return seen;
}

function onlyPlayer(s: GameSession): void {
  const st = structuredClone(s.state) as GameState;
  st.area.actors = st.area.actors.filter((a) => a.id === leadPlayer(st).actorId);
  s.state = st;
}

function teleport(s: GameSession, x: number, y: number): void {
  const st = structuredClone(s.state) as GameState;
  st.area.actors.find((a) => a.id === leadPlayer(st).actorId)!.pos = { x, y };
  s.state = st;
}

describe('offline GM director', () => {
  it('narrates the intro from gm.fallback.intro (card + log)', () => {
    const s = session();
    const seen = pump(s);
    expect(seen.map((x) => x.hook)).toEqual(['intro']);
    expect(s.narration?.kind).toBe('intro');
    expect(s.narration?.text).toBe(western.gm.fallback.intro);
    expect(s.state.log.some((l) => l.kind === 'gm' && l.text === western.gm.fallback.intro)).toBe(true);
  });

  it('entering an area produces the area arrival narration', () => {
    const s = session(ship, 3);
    pump(s);
    onlyPlayer(s);
    const ex = s.state.area.map.exit;
    teleport(s, ex.x, ex.y);
    const out = s.act({ type: 'transition' });
    expect(out.areaChanged).toBe(true);
    const hooks = pump(s);
    expect(hooks.map((h) => h.hook)).toContain('area_enter');
    const line = ship.gm.fallback.areaEnter[1];
    expect(s.narration?.kind).toBe('area_enter');
    expect(s.narration?.title).toBe(ship.areas[1].name);
    expect(s.narration?.text).toBe(line);
    expect(s.state.log.some((l) => l.kind === 'gm' && l.text === line)).toBe(true);
  });

  it('fires exactly one event per area, within the GM budget', () => {
    const s = session(western, 5);
    pump(s);
    onlyPlayer(s);
    let events = 0;
    for (let t = 0; t < 140; t++) {
      s.act({ type: 'wait' });
      if (s.ended) break;
      for (const x of pump(s)) if (x.response?.actions.some((a) => a.type === 'set_flag' && a.flag === eventFlag(0))) events++;
      if (leadPlayer(s.state).pendingChoice) s.act({ type: 'choose_option', index: leadPlayer(s.state).pendingChoice!.options.length - 1 });
    }
    expect(events).toBe(1);
    expect(s.state.flags[eventFlag(0)]).toBe(true);
    expect(s.state.area.gmBudget).toBeGreaterThanOrEqual(0);
    expect(s.state.area.gmBudget).toBeLessThan(GM_BUDGET_PER_AREA);
    // its story line made it into the log
    expect(s.state.log.some((l) => l.kind === 'gm' && western.gm.fallback.events.includes(l.text))).toBe(true);
  });

  it('never spends more than the area budget allows', () => {
    const d = new OfflineGmDirector({ eventDelay: 0 });
    const s = session(ship, 9);
    const st = structuredClone(s.state) as GameState;
    st.area.gmBudget = 1;
    s.state = st;
    const r = d.respondSync({ hook: 'idle', area: 0, turn: 50, ctx: { ...s.gmContext(), areaEnteredTurn: 0 } });
    // nothing affordable: narration only (cost 0), and the area is marked done
    expect(r).not.toBeNull();
    expect(responseCost(r!.actions)).toBeLessThanOrEqual(1);
  });

  it('is deterministic for a seed', () => {
    const a = new OfflineGmDirector({ eventDelay: 0 });
    const s1 = session(ship, 11);
    const s2 = session(ship, 11);
    const req = (s: GameSession) => ({ hook: 'idle' as const, area: 0, turn: 30, ctx: { ...s.gmContext(), areaEnteredTurn: 0 } });
    expect(a.respondSync(req(s1))).toEqual(a.respondSync(req(s2)));
  });

  it('gives a nearby NPC one canned line when a region opens', () => {
    const d = new OfflineGmDirector({ eventDelay: 999 });
    const s = session(western, 2);
    const npcDef = western.actors.find((x) => x.npc && x.npc.lines.length)!;
    const st = structuredClone(s.state) as GameState;
    const pl = st.area.actors.find((a) => a.id === leadPlayer(st).actorId)!;
    st.area.actors = [pl, { ...structuredClone(pl), id: 'a900', defId: npcDef.id, faction: 'neutral', pos: { x: pl.pos.x + 1, y: pl.pos.y } }];
    s.state = st;
    s.act({ type: 'wait' });
    const r = d.respondSync({ hook: 'region_discovered', area: 0, turn: s.state.turn, ctx: s.gmContext() });
    expect(r?.actions[0]).toMatchObject({ type: 'say', actorId: 'a900' });
    expect(npcDef.npc!.lines).toContain((r!.actions[0] as { text: string }).text);
    s.applyGm(r!.actions, { hook: 'region_discovered', area: 0 });
    // once per NPC
    expect(d.respondSync({ hook: 'region_discovered', area: 0, turn: s.state.turn, ctx: s.gmContext() })).toBeNull();
  });
});

describe('hook detection', () => {
  it('turns step events into GM hooks and fires idle hooks on a timer', () => {
    const s = session();
    const tr = newHookTracker(0);
    const before = s.state;
    s.act({ type: 'wait' });
    const quiet = gmHooksFor(western, before, s.state, [], tr);
    expect(quiet).toEqual([]);
    const later = { ...s.state, turn: 30 } as GameState;
    const idle = gmHooksFor(western, s.state, later, [], tr);
    expect(idle.map((h) => h.hook)).toEqual(['idle']);
    const lv = gmHooksFor(western, later, later, [{ type: 'level_up', level: 2, choices: [] }, { type: 'low_hp' }], tr);
    expect(lv.map((h) => h.hook).sort()).toEqual(['low_hp', 'milestone']);
  });

  it('prefers the engine hook queue when the state carries one, and drains it', () => {
    const s = session();
    s.takeHooks();
    const st = structuredClone(s.state) as GameState & { gmQueue?: unknown[] };
    st.gmQueue = [{ hook: 'boss_seen', area: 0, turn: 3 }, 'milestone', { hook: 'bogus' }];
    s.state = st;
    s.act({ type: 'wait' });
    const hooks = s.takeHooks();
    expect(hooks.map((h) => h.hook)).toEqual(['boss_seen', 'milestone']);
    expect((s.state as GameState & { gmQueue?: unknown[] }).gmQueue).toEqual([]);
  });
});

describe('GM runner', () => {
  const ctxOf = (s: GameSession) => s.gmContext();

  it('falls back to the offline director when the provider is too slow, without blocking play', async () => {
    const s = session();
    const results: GmResult[] = [];
    const slow: GmDirector = { name: 'slow', respond: () => new Promise(() => {}) };
    const runner = new GmRunner(slow, { fallback: new OfflineGmDirector(), timeoutMs: 20, onResult: (r) => results.push(r) });
    const [intro] = s.takeHooks();
    runner.request(intro, ctxOf(s));
    // play goes on while the GM thinks
    const t0 = s.state.turn;
    s.act({ type: 'wait' });
    expect(s.state.turn).toBeGreaterThan(t0);
    await runner.idle();
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('offline');
    s.applyGm(results[0].response.actions, { hook: 'intro', area: 0 });
    expect(s.state.log.some((l) => l.text === western.gm.fallback.intro)).toBe(true);
  });

  it('falls back when the provider rejects or answers garbage', async () => {
    const s = session();
    const results: GmResult[] = [];
    const errors: string[] = [];
    const bad: GmDirector = { name: 'bad', respond: () => Promise.reject(new Error('503')) };
    const runner = new GmRunner(bad, { fallback: new OfflineGmDirector(), timeoutMs: 200, onResult: (r) => results.push(r), onError: (_e, _r, who) => errors.push(who) });
    runner.request({ hook: 'intro', area: 0, turn: 0 }, ctxOf(s));
    await runner.idle();
    expect(errors).toEqual(['bad']);
    expect(results[0]?.source).toBe('offline');

    const junk: GmDirector = { name: 'junk', respond: async () => ({ actions: [{ type: 'explode' }] }) as unknown as GmResponse };
    runner.setDirector(junk);
    runner.request({ hook: 'intro', area: 0, turn: 0 }, ctxOf(s));
    await runner.idle();
    expect(results[1]?.source).toBe('offline');
  });

  it('drops answers that arrive after the area changed', async () => {
    const s = session();
    const results: GmResult[] = [];
    let release: (r: GmResponse) => void = () => {};
    const late: GmDirector = { name: 'late', respond: (req) => new Promise((res) => { release = res; req.signal.addEventListener('abort', () => res({ actions: [{ type: 'narrate', text: 'too late' }] })); }) };
    const runner = new GmRunner(late, { timeoutMs: 1000, onResult: (r) => results.push(r) });
    runner.request({ hook: 'area_enter', area: 0, turn: 0 }, ctxOf(s));
    runner.request({ hook: 'idle', area: 0, turn: 0 }, ctxOf(s));
    runner.cancelAll(); // the player took the exit
    release({ actions: [{ type: 'narrate', text: 'stale' }] });
    await runner.idle();
    expect(results).toEqual([]);
    expect(runner.pending).toBe(0);
  });

  it('a null answer means "nothing to add" (no fallback, no result)', async () => {
    const s = session();
    const results: GmResult[] = [];
    const quiet: GmDirector = { name: 'quiet', respond: async () => null };
    const runner = new GmRunner(quiet, { fallback: new OfflineGmDirector(), onResult: (r) => results.push(r) });
    runner.request({ hook: 'intro', area: 0, turn: 0 }, ctxOf(s));
    await runner.idle();
    expect(results).toEqual([]);
  });

  it('keeps arrival hooks when the queue overflows', async () => {
    const s = session();
    const order: string[] = [];
    const d: GmDirector = { name: 'rec', respond: async (r) => (order.push(r.hook), null) };
    const runner = new GmRunner(d, { maxQueue: 2, onResult: () => {} });
    runner.request({ hook: 'idle', area: 0, turn: 1 }, ctxOf(s)); // starts running at once
    runner.request({ hook: 'milestone', area: 0, turn: 1 }, ctxOf(s));
    runner.request({ hook: 'region_discovered', area: 0, turn: 1 }, ctxOf(s));
    runner.request({ hook: 'area_enter', area: 0, turn: 1 }, ctxOf(s));
    await runner.idle();
    expect(order).toContain('area_enter');
    expect(order).not.toContain('milestone');
  });

  it('sanitizes responses', () => {
    expect(sanitizeResponse(null)).toBeNull();
    expect(sanitizeResponse({ actions: 'x' })).toBeNull();
    expect(sanitizeResponse({ actions: [{ type: 'narrate', text: 'hi' }, { nope: 1 }] })).toEqual({ actions: [{ type: 'narrate', text: 'hi' }] });
  });
});

describe('GameSession.applyGm', () => {
  it('ignores answers for another area or after the run ended', () => {
    const s = session();
    const before = s.state;
    expect(s.applyGm([{ type: 'narrate', text: 'x' }], { hook: 'idle', area: 3 }).changed).toBe(false);
    expect(s.state).toBe(before);
  });

  it('applies budgeted actions and reports their events', () => {
    const s = session(ship, 4);
    const item = ship.items[0].id;
    const out = s.applyGm([{ type: 'place_item', item, near: 'player' }], { hook: 'idle', area: 0 });
    expect(out.changed).toBe(true);
    expect(s.state.area.items.some((fi) => fi.item.defId === item)).toBe(true);
    expect(s.state.area.gmBudget).toBe(GM_BUDGET_PER_AREA - 2);
  });

  it('an event narration opens an event card that the next action clears', () => {
    const s = session();
    s.dismissNarration('intro');
    s.applyGm([{ type: 'narrate', text: 'A wind rises.' }], { hook: 'idle', area: 0 });
    expect(s.narration).toMatchObject({ kind: 'event', text: 'A wind rises.' });
    s.act({ type: 'wait' });
    expect(s.narration).toBeNull();
  });
});
