/**
 * MP2 C3: the turn clock (server/rooms/clock.ts nextResolve), rule by rule: nobody connected,
 * countdown, area hold, all acted (decide now, travel cadence, empty active set, only slow or
 * inactive players' inputs → advance), the deadline (also from a carried-over input's fresh
 * start and not before a hold), nothing pending, and wakeAt; MP5: calm turns (no hostile in view:
 * travel at the cadence, other inputs after a short grace) and a down player getting up while the
 * others do nothing; hostileInView on a party's fog.
 */
import { describe, it, expect } from 'vitest';
import { hostileInView, nextResolve, type ClockView, type PendingInput } from '../../server/rooms/clock';
import { DEFAULT_TIMING, roomTiming, type RoomTiming } from '../../server/rooms/timing';

const NOW = 10_000;

function view(over: Partial<ClockView> & { pend?: Record<string, Partial<PendingInput>> } = {}): ClockView {
  const { pend, ...rest } = over;
  const pending = new Map<string, PendingInput>(Object.entries(pend ?? {}).map(([id, p]) => [id, { intent: 'decide', at: NOW - 100, ready: true, ...p }]));
  return {
    active: ['p1', 'p2'],
    ready: ['p1', 'p2'],
    pending,
    firstAt: pending.size ? NOW - 100 : null,
    lastResolveAt: NOW - 50,
    deadlineMs: 2000,
    travelMs: 100,
    countdownTurnMs: 1000,
    calmGraceMs: 300,
    calm: false,
    calmFlow: true,
    downWaiting: false,
    countdown: false,
    areaHoldUntil: null,
    anyConnected: true,
    wakes: [],
    ...rest,
  };
}

describe('nextResolve', () => {
  it('rule 0: nobody connected sleeps (no resolve, no wake), countdown included', () => {
    expect(nextResolve(view({ anyConnected: false, countdown: true, pend: { p1: {} }, wakes: [NOW + 5] }), NOW)).toEqual({ resolve: null, wakeAt: null });
  });

  it('rule 1: a countdown resolves every countdownTurnMs with advance, acted or not', () => {
    expect(nextResolve(view({ countdown: true }), NOW).resolve).toEqual({ at: NOW - 50 + 1000, advance: true });
    expect(nextResolve(view({ countdown: true, pend: { p1: {}, p2: {} } }), NOW).resolve).toEqual({ at: NOW + 950, advance: true });
  });

  it('rule 2: nothing resolves during an area hold; the hold end is a wake and the deadline starts after it', () => {
    const v = view({ areaHoldUntil: NOW + 500, pend: { p1: {}, p2: {} } });
    expect(nextResolve(v, NOW)).toEqual({ resolve: null, wakeAt: NOW + 500 });
    // after the hold the deadline counts from its end, not from the input that came during it
    const after = view({ areaHoldUntil: NOW - 10, firstAt: NOW - 1500, pend: { p1: {} } });
    expect(nextResolve(after, NOW).resolve).toEqual({ at: NOW - 10 + 2000, advance: true });
  });

  it('rule 3: everyone acted with a decide intent resolves now, without advance', () => {
    expect(nextResolve(view({ pend: { p1: {}, p2: { intent: 'travel' } } }), NOW).resolve).toEqual({ at: NOW, advance: false });
  });

  it('rule 3: everyone travelling or waiting resolves at the travel cadence', () => {
    expect(nextResolve(view({ pend: { p1: { intent: 'travel' }, p2: { intent: 'wait' } } }), NOW).resolve).toEqual({ at: NOW - 50 + 100, advance: false });
  });

  it('rule 3: an empty active set counts as all acted (idle, busy and menu players never hold a turn)', () => {
    expect(nextResolve(view({ active: [], pend: { p1: {} } }), NOW).resolve).toEqual({ at: NOW, advance: false });
    // only an idle player's own input: at once
    expect(nextResolve(view({ active: ['p2'], pend: { p2: {} } }), NOW).resolve).toEqual({ at: NOW, advance: false });
  });

  it('rule 3: no pending input from a ready player → travel cadence with advance (the slow ones catch up)', () => {
    const v = view({ active: [], ready: ['p2'], pend: { p1: { ready: false } } });
    expect(nextResolve(v, NOW).resolve).toEqual({ at: NOW + 50, advance: true });
    // a party of one after a leave, below 100 energy: the same
    expect(nextResolve(view({ active: [], ready: [], pend: { p1: { ready: false } } }), NOW).resolve).toEqual({ at: NOW + 50, advance: true });
  });

  it('rule 4: someone active has not acted → the deadline from the first input, with advance', () => {
    expect(nextResolve(view({ pend: { p1: {} } }), NOW).resolve).toEqual({ at: NOW - 100 + 2000, advance: true });
    expect(nextResolve(view({ pend: { p1: {} }, deadlineMs: 5000 }), NOW).resolve).toEqual({ at: NOW - 100 + 5000, advance: true });
  });

  it('rule 4: a carried-over input gets a fresh start (firstAt = the resolve that carried it)', () => {
    const v = view({ lastResolveAt: NOW - 20, firstAt: NOW - 20, pend: { p1: { ready: false, at: NOW - 20 } }, active: ['p2'] });
    expect(nextResolve(v, NOW).resolve).toEqual({ at: NOW - 20 + 2000, advance: true });
  });

  it('rule 5: nothing pending outside a countdown: the world does not move', () => {
    expect(nextResolve(view(), NOW).resolve).toBeNull();
    expect(nextResolve(view({ active: [] }), NOW).resolve).toBeNull();
  });

  it('rule 4a: calm, travel and wait never wait for a thinking teammate (the travel cadence, with advance)', () => {
    expect(nextResolve(view({ calm: true, pend: { p1: { intent: 'travel' } } }), NOW).resolve).toEqual({ at: NOW - 50 + 100, advance: true });
    expect(nextResolve(view({ calm: true, pend: { p1: { intent: 'wait' } }, active: ['p1', 'p2', 'p3'] }), NOW).resolve).toEqual({ at: NOW + 50, advance: true });
    // not calm, or the switch off (tests of the waiting UI): the deadline as before
    expect(nextResolve(view({ calm: false, pend: { p1: { intent: 'travel' } } }), NOW).resolve).toEqual({ at: NOW - 100 + 2000, advance: true });
    expect(nextResolve(view({ calm: true, calmFlow: false, pend: { p1: { intent: 'travel' } } }), NOW).resolve).toEqual({ at: NOW - 100 + 2000, advance: true });
    // (rule 6 does not depend on the switch)
    expect(nextResolve(view({ calm: true, calmFlow: false, downWaiting: true }), NOW).resolve).toEqual({ at: NOW - 50 + 1000, advance: true });
  });

  it('rule 4a: calm, a decide input waits only the short grace (never before the travel cadence)', () => {
    expect(nextResolve(view({ calm: true, pend: { p1: {} } }), NOW).resolve).toEqual({ at: NOW - 100 + 300, advance: true });
    expect(nextResolve(view({ calm: true, lastResolveAt: NOW - 10, firstAt: NOW - 400, pend: { p1: {} } }), NOW).resolve).toEqual({ at: NOW + 90, advance: true });
    // everyone acted: rule 3 still decides (at once)
    expect(nextResolve(view({ calm: true, pend: { p1: {}, p2: {} } }), NOW).resolve).toEqual({ at: NOW, advance: false });
  });

  it('rule 6: someone down and nothing pending: a turn every countdownTurnMs while calm, none in a fight or a hold', () => {
    expect(nextResolve(view({ downWaiting: true, calm: true }), NOW).resolve).toEqual({ at: NOW - 50 + 1000, advance: true });
    expect(nextResolve(view({ downWaiting: true, calm: false }), NOW).resolve).toBeNull();
    expect(nextResolve(view({ downWaiting: true, calm: true, areaHoldUntil: NOW + 200 }), NOW).resolve).toBeNull();
    expect(nextResolve(view({ downWaiting: true, calm: true, anyConnected: false }), NOW).resolve).toBeNull();
  });

  it('roomTiming: durations take positive numbers, the calmFlow switch only a boolean', () => {
    expect(roomTiming({ calmFlow: false, travelMs: 30 })).toMatchObject({ calmFlow: false, travelMs: 30 });
    expect(roomTiming({ calmFlow: 0 as unknown as boolean, travelMs: -1 } as Partial<RoomTiming>)).toMatchObject({ calmFlow: true, travelMs: DEFAULT_TIMING.travelMs });
  });

  it('hostileInView: a living hostile on a tile a standing member sees now; down eyes, allies and corpses do not count', () => {
    const seen = (i: number) => Array.from({ length: 9 }, (_, k) => (k === i ? 2 : 1));
    const state = {
      area: {
        map: { width: 3, height: 3 },
        actors: [
          { id: 'a1', hp: 10, faction: 'player', pos: { x: 0, y: 0 } },
          { id: 'a2', hp: 10, faction: 'player', pos: { x: 1, y: 0 } },
          { id: 'h', hp: 5, faction: 'hostile', pos: { x: 2, y: 2 } },
        ],
      },
      party: ['p1', 'p2'],
      players: { p1: { actorId: 'a1', seen: seen(0) }, p2: { actorId: 'a2', seen: seen(8) } },
    } as unknown as Parameters<typeof hostileInView>[0];
    expect(hostileInView(state)).toBe(true);
    (state.players.p2 as { down?: unknown }).down = { since: 1, helpedTurns: 0 };
    expect(hostileInView(state)).toBe(false);
    delete (state.players.p2 as { down?: unknown }).down;
    (state.area.actors[2] as { allyOf?: string }).allyOf = 'a1';
    expect(hostileInView(state)).toBe(false);
    delete (state.area.actors[2] as { allyOf?: string }).allyOf;
    state.area.actors[2]!.hp = 0;
    expect(hostileInView(state)).toBe(false);
  });

  it('wakeAt is the earliest wake after now (past wakes ignored)', () => {
    expect(nextResolve(view({ wakes: [NOW - 5, NOW + 300, NOW + 100] }), NOW).wakeAt).toBe(NOW + 100);
    expect(nextResolve(view({ wakes: [NOW] }), NOW).wakeAt).toBeNull();
    expect(nextResolve(view({ wakes: [NOW + 900], areaHoldUntil: NOW + 400 }), NOW).wakeAt).toBe(NOW + 400);
  });
});
