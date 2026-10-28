/**
 * MP2 C3: the turn clock (server/rooms/clock.ts nextResolve), rule by rule: nobody connected,
 * countdown, area hold, all acted (decide now, travel cadence, empty active set, only slow or
 * inactive players' inputs → advance), the deadline (also from a carried-over input's fresh
 * start and not before a hold), nothing pending, and wakeAt.
 */
import { describe, it, expect } from 'vitest';
import { nextResolve, type ClockView, type PendingInput } from '../../server/rooms/clock';

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

  it('wakeAt is the earliest wake after now (past wakes ignored)', () => {
    expect(nextResolve(view({ wakes: [NOW - 5, NOW + 300, NOW + 100] }), NOW).wakeAt).toBe(NOW + 100);
    expect(nextResolve(view({ wakes: [NOW] }), NOW).wakeAt).toBeNull();
    expect(nextResolve(view({ wakes: [NOW + 900], areaHoldUntil: NOW + 400 }), NOW).wakeAt).toBe(NOW + 400);
  });
});
