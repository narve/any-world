/**
 * Regression tests for the M2 round-1 playtest issues owned by the client:
 *  - issues/M2-direction-target-cursor.md
 *  - issues/M2-consumable-wasted-when-full.md
 *  - issues/M2-objective-hint-truncated.md
 *  - issues/M2-xp-bar-overflow.md
 */
import { describe, it, expect } from 'vitest';
import type { GameState } from '../../src/engine/types';
import { GameSession } from '../../src/client/session';
import { aimsDirection, objectiveOf, objectiveParts, wastedRestore, xpProgress } from '../../src/client/view';
import { playerSheet, leadPlayer } from '../../src/engine/index';
import { loadFixture, roomMap } from '../engine/helpers';

const western = loadFixture('fixture-western.json');
const ship = loadFixture('fixture-ship.json');

function session(world = ship, seed = 1) {
  return new GameSession({ world, worldId: 'fixture-test', seed, map: roomMap(14, 10) });
}

function onlyPlayer(s: GameSession): void {
  const st = structuredClone(s.state) as GameState;
  st.area.actors = st.area.actors.filter((a) => a.id === leadPlayer(st).actorId);
  s.state = st;
}

function slotOf(s: GameSession, defId: string): number {
  const i = leadPlayer(s.state).slots.findIndex((x) => x?.defId === defId);
  if (i < 0) throw new Error(`${defId} not carried`);
  return i;
}

describe('direction-aimed items (Arc Weld)', () => {
  const weld = ship.items.find((i) => i.id === 'arc-weld')!;

  it('is recognised as direction-aimed', () => {
    expect(aimsDirection(weld)).toBe(true);
    expect(aimsDirection(ship.items.find((i) => i.id === 'o2-canister')!)).toBe(false);
  });

  it('never starts the cursor on the player and Enter fires in the facing direction', () => {
    const s = session();
    onlyPlayer(s);
    s.uiAction({ type: 'move', dir: 'e' });
    const p = s.player().pos;
    const slot = slotOf(s, 'arc-weld');
    s.uiAction({ type: 'use', slot });
    expect(s.mode).toBe('target');
    expect(s.aimingDirection()).toBe(true);
    expect(s.cursor).toEqual({ x: p.x + 1, y: p.y });
    expect(s.aim()).toEqual({ from: p, at: { x: p.x + 1, y: p.y } });
    const turn = s.state.turn;
    const out = s.intent({ type: 'confirm_cursor' });
    expect(out.toasts.map((t) => t.text).join(' ')).not.toMatch(/direction/i);
    expect(s.state.turn).toBeGreaterThan(turn);
    expect(s.mode).toBe('normal');
  });

  it('arrow keys pick one of the eight directions around the player', () => {
    const s = session();
    onlyPlayer(s);
    const p = s.player().pos;
    s.uiAction({ type: 'use', slot: slotOf(s, 'arc-weld') });
    s.intent({ type: 'target_move', dir: 'n' });
    expect(s.cursor).toEqual({ x: p.x, y: p.y - 1 });
    // pressing again does not walk the cursor away: it is still a direction
    s.intent({ type: 'target_move', dir: 'n' });
    expect(s.cursor).toEqual({ x: p.x, y: p.y - 1 });
    s.intent({ type: 'target_move', dir: 'sw' });
    expect(s.cursor).toEqual({ x: p.x - 1, y: p.y + 1 });
  });

  it('the slot view and banner know the item is aimed by direction', () => {
    const s = session();
    const slot = slotOf(s, 'arc-weld');
    expect(s.viewModel().game!.slots[slot]!.aimsDirection).toBe(true);
  });
});

describe('consumables whose vitals are already full', () => {
  it('O2 at max: the first press warns, the second uses it', () => {
    const s = session();
    onlyPlayer(s);
    const slot = slotOf(s, 'o2-canister');
    const count = leadPlayer(s.state).slots[slot]!.count ?? 1;
    const sheet = playerSheet(s.state);
    const o2 = sheet.resources.find((r) => r.id === 'oxygen')!;
    expect(o2.value).toBe(o2.max);
    const first = s.uiAction({ type: 'use', slot });
    expect(first.changed).toBe(false);
    expect(first.toasts[0].text).toMatch(/already full.*press again/);
    expect(leadPlayer(s.state).slots[slot]!.count ?? 1).toBe(count);
    const second = s.uiAction({ type: 'use', slot });
    expect(second.changed).toBe(true);
    expect(leadPlayer(s.state).slots[slot]?.count ?? 0).toBe(count - 1);
  });

  it('another action in between re-arms the warning', () => {
    const s = session();
    onlyPlayer(s);
    const slot = slotOf(s, 'o2-canister');
    expect(s.uiAction({ type: 'use', slot }).changed).toBe(false);
    s.uiAction({ type: 'wait' });
    // the wait used some O2 (drain), so refill it: the canister is wasted again
    const st = structuredClone(s.state) as GameState;
    leadPlayer(st).resources.oxygen = ship.resources.find((r) => r.id === 'oxygen')!.max;
    s.state = st;
    expect(s.uiAction({ type: 'use', slot }).changed).toBe(false);
  });

  it('no warning when the vital is not full, or the item cures a condition the user has', () => {
    const can = ship.items.find((i) => i.id === 'o2-canister')!;
    const s = session();
    const sheet = playerSheet(s.state);
    const full = wastedRestore(ship, can, sheet, []);
    const o2name = ship.resources.find((r) => r.id === 'oxygen')!.name;
    expect(full).toBe(o2name);
    const low = { ...sheet, resources: sheet.resources.map((r) => (r.id === 'oxygen' ? { ...r, value: r.max - 1 } : r)) };
    expect(wastedRestore(ship, can, low, [])).toBeNull();
    expect(wastedRestore(ship, can, sheet, [{ id: 'hypoxic' }])).toBeNull();
    // something with another effect (a status) is never "wasted"
    const poultice = ship.items.find((i) => i.id === 'moss-poultice')!;
    expect(wastedRestore(ship, poultice, sheet, [])).toBeNull();
    // a plain heal at full health is
    const ration = ship.items.find((i) => i.id === 'ration-brick')!;
    expect(wastedRestore(ship, ration, { ...sheet, hp: sheet.maxHp }, [])).toBe(ship.vocabulary.stats.hp.name);
    expect(wastedRestore(ship, ration, { ...sheet, hp: sheet.maxHp - 1 }, [])).toBeNull();
  });
});

describe('objective line', () => {
  it('splits the goal from the where-to-go hint', () => {
    const s = session(western);
    const parts = objectiveParts(western, s.state, false);
    expect(parts.goal).toBe(western.goal.summary);
    expect(parts.hint).toMatch(/^(Find the way on from|The way on)/);
    const g = s.viewModel().game!;
    expect(g.objective).toBe(western.goal.summary);
    expect(g.objectiveHint).toBe(parts.hint);
    expect(objectiveOf(western, s.state, false)).toBe(`${parts.goal} — ${parts.hint![0].toLowerCase()}${parts.hint!.slice(1)}`);
  });

  it('on the exit the hint says which key to press', () => {
    const s = session(western);
    expect(objectiveParts(western, s.state, true).hint).toMatch(/^Press > to /);
  });
});

describe('xp progress with queued level-ups', () => {
  const g = western.player.growth;
  const need = (lv: number) => Math.max(1, Math.round(g.firstLevelXp * Math.pow(g.curve, Math.max(0, lv - 1))));

  it('below the threshold it is plain progress', () => {
    expect(xpProgress(western, 1, 5, need(1))).toEqual({ xpInLevel: 5, xpForLevel: need(1) });
  });

  it('over the threshold the bar is clamped and the queued level-ups are counted', () => {
    const lv = 2;
    const xp = need(2) + need(3) + 1;
    const v = xpProgress(western, lv, xp, need(2));
    expect(v.xpInLevel).toBe(need(2));
    expect(v.xpForLevel).toBe(need(2));
    expect(v.pendingLevels).toBe(2);
  });

  it('the HUD never shows more xp than the bar holds after a large grant', () => {
    const s = session(western);
    const st = structuredClone(s.state) as GameState;
    leadPlayer(st).xp = 500; // what the engine holds while a perk choice blocks further level-ups
    s.state = st;
    const hud = s.viewModel().game!.hud;
    expect(hud.xpInLevel).toBeLessThanOrEqual(hud.xpForLevel);
    if (leadPlayer(s.state).xp >= hud.xpForLevel) expect(hud.pendingLevels).toBeGreaterThan(0);
  });
});
