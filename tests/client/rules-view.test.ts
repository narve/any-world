/**
 * Rules panel from the live rule list (audit "Rules panel from live activeRules"): world rules show
 * "from the start", GM rules show "<area word> N, turn T", their reason and a GM marker; a new rule
 * raises a toast + log line and is highlighted; a lifted rule disappears.
 */
import { describe, it, expect } from 'vitest';
import type { GameState } from '../../src/engine/types';
import type { RuleVariant } from '../../src/schema/world';
import { GameSession } from '../../src/client/session';
import { activeRulesOf, RuleTracker, NEW_RULE_TURNS } from '../../src/client/rules';
import { rulesView, sinceLabel } from '../../src/client/view';
import { loadFixture, roomMap } from '../engine/helpers';

const ship = loadFixture('fixture-ship.json');

const tide: RuleVariant = { id: 'rising-tide', name: 'Rising tide', description: 'Low tiles flood every 20 turns.', playerTriggers: [], switches: {} };

function session(seed = 1) {
  return new GameSession({ world: ship, worldId: 'fixture-test', seed, map: roomMap(14, 10) });
}

function withRules(s: GameSession, entries: unknown[]): void {
  const st = structuredClone(s.state) as GameState;
  (st as { activeRules?: unknown[] }).activeRules = entries;
  s.state = st;
}

describe('activeRulesOf', () => {
  it('falls back to the world rules when the engine has no live list', () => {
    const s = session();
    expect(activeRulesOf(ship, s.state).map((r) => r.rule.id)).toEqual(ship.rules.map((r) => r.id));
    expect(activeRulesOf(ship, s.state).every((r) => r.source === 'world')).toBe(true);
  });

  it('reads wrapped and bare entries, marks GM rules and drops duplicates/junk', () => {
    const s = session();
    withRules(s, [ship.rules[0], { rule: tide, source: 'gm', since: { area: 1, turn: 140 }, reason: 'The sea remembers.' }, { rule: tide }, null, { nonsense: true }]);
    const rs = activeRulesOf(ship, s.state);
    expect(rs.map((r) => r.rule.id)).toEqual([ship.rules[0].id, 'rising-tide']);
    expect(rs[1]).toMatchObject({ source: 'gm', sinceArea: 1, sinceTurn: 140, reason: 'The sea remembers.' });
  });
});

describe('rulesView', () => {
  it('labels since-when with the world vocabulary', () => {
    expect(sinceLabel(ship, undefined, undefined)).toBe('from the start');
    expect(sinceLabel(ship, 1, 140)).toBe(`${ship.vocabulary.area} 2, turn 140`);
    const s = session();
    withRules(s, [{ rule: tide, source: 'gm', since: { area: 0, turn: 12 }, reason: 'Water rises.' }]);
    const v = rulesView(ship, s.state);
    expect(v).toEqual([{ id: 'rising-tide', name: 'Rising tide', description: tide.description, since: `${ship.vocabulary.area} 1, turn 12`, fromGm: true, reason: 'Water rises.' }]);
  });
});

/** engine-shaped live entries (GameState.activeRules is ActiveRuleEntry[] since M2) */
const W = (r: RuleVariant) => ({ rule: r, source: 'world' as const, since: { area: 0, turn: 0 } });
const G = (r: RuleVariant, turn: number, reason?: string) => ({ rule: r, source: 'gm' as const, since: { area: 0, turn }, ...(reason ? { reason } : {}) });

describe('rule changes in a session', () => {
  it('announces a GM rule (toast + log), highlights it, and removes a lifted one', () => {
    const s = session();
    const world0 = ship.rules[0];
    const first = s.viewModel().game!.rules;
    expect(first.map((r) => r.since)).toEqual(ship.rules.map(() => 'from the start'));

    // the engine adds a GM rule (as applyGmActions add_rule does in M2)
    const addedAt = s.state.turn;
    withRules(s, [...ship.rules.map(W), G(tide, addedAt, 'The ballast tanks are failing.')]);
    const out = s.act({ type: 'wait' });
    expect(out.rules?.map((c) => [c.kind, c.id])).toEqual([['added', 'rising-tide']]);
    expect(out.toasts.some((t) => t.text === 'New rule: Rising tide')).toBe(true);
    const g = s.viewModel().game!;
    const added = g.rules.find((r) => r.id === 'rising-tide')!;
    expect(added).toMatchObject({ fromGm: true, isNew: true, reason: 'The ballast tanks are failing.' });
    // the engine's own `since` (when the GM added it) is what the panel shows
    expect(added.since).toBe(`${ship.vocabulary.area} 1, turn ${addedAt}`);
    expect(g.log.some((l) => l.kind === 'gm' && l.text.startsWith('Rising tide'))).toBe(true);

    // seen once the rules panel opens
    s.acknowledgeRules();
    expect(s.viewModel().game!.rules.find((r) => r.id === 'rising-tide')!.isNew).toBeUndefined();

    // lifted: gone from the panel, announced
    withRules(s, [...ship.rules.filter((r) => r.id !== world0.id).map(W), G(tide, addedAt)]);
    const out2 = s.act({ type: 'wait' });
    expect(out2.rules?.map((c) => [c.kind, c.id])).toEqual([['removed', world0.id]]);
    expect(s.viewModel().game!.rules.some((r) => r.id === world0.id)).toBe(false);
  });

  it('the highlight fades after a while and the memo survives a save', () => {
    const s = session();
    const addedAt = s.state.turn;
    withRules(s, [...ship.rules.map(W), G(tide, addedAt)]);
    s.act({ type: 'wait' });
    const saved = s.savedRun(0);
    expect(saved.rules?.find((m) => m.id === 'rising-tide')?.sinceTurn).toBe(addedAt);
    for (let i = 0; i <= NEW_RULE_TURNS; i++) s.act({ type: 'wait' });
    expect(s.viewModel().game!.rules.find((r) => r.id === 'rising-tide')?.isNew).toBeUndefined();

    const tr = new RuleTracker(saved.rules);
    expect(tr.memoFor('rising-tide')?.source).toBe('gm');
  });
});
