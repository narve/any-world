/**
 * GM rules during play (DESIGN §4.3): add_rule / remove_rule, state.activeRules, the limits
 * (MAX_ACTIVE_RULES, MAX_GM_RULES_PER_AREA, difficulty harm allowance), live switches/triggers,
 * save/load, no residue after removal, and the GM budget hardening (prototype-key action types).
 */
import { describe, it, expect } from 'vitest';
import type { GmAction } from '../../src/schema/gm';
import { GM_ACTION_COST, GM_BUDGET_PER_AREA, MAX_ACTIVE_RULES } from '../../src/schema/gm';
import type { RuleVariant, WorldSpec } from '../../src/schema/world';
import { applyGmActions, createGame, deserialize, playerSheet, serialize, step, leadPlayer } from '../../src/engine';
import type { GameState } from '../../src/engine/types';
import { estimateRuleImpact } from '../../src/engine/rules';
import { simRule } from '../../src/engine/sim/gm-script';
import { GameSession } from '../../src/client/session';
import { testWorld, newGame, env, player, act, loadFixture, roomMap, simpleGenerator } from './helpers';

const self = { shape: 'self', range: 0, radius: 0, affects: 'self_only', needsLos: false } as const;

function rule(id: string, over: Partial<RuleVariant> = {}): RuleVariant {
  return { id, name: id, description: `${id} rule`, playerTriggers: [], switches: {}, ...over };
}

/** a rule that burns the player for `n` every `every` turns */
function burnRule(id: string, n: number, every = 1): RuleVariant {
  return rule(id, { playerTriggers: [{ on: 'on_turn', every, chance: 1, action: { targeting: self, effects: [{ type: 'damage', amount: { base: n }, damageType: 'fire' }] } }] });
}

const add = (r: RuleVariant, reason = 'it changes'): GmAction => ({ type: 'add_rule', rule: r, reason });
const remove = (id: string, reason = 'it passes'): GmAction => ({ type: 'remove_rule', id, reason });

function ids(s: GameState): string[] {
  return (s.activeRules ?? []).map((e) => e.rule.id);
}

describe('activeRules', () => {
  it('a new run starts with the world rules in force', () => {
    const ship = loadFixture('fixture-ship.json');
    const s = createGame(ship, { seed: 1, map: roomMap(), mapGenerator: simpleGenerator });
    expect(ids(s)).toEqual(ship.rules.map((r) => r.id));
    expect(s.activeRules!.every((e) => e.source === 'world' && e.since.area === 0 && e.since.turn === 0)).toBe(true);
  });

  it('add_rule puts the rule in force (charged 4, announced, event) and remove_rule lifts it (charged 2)', () => {
    const western = loadFixture('fixture-western.json');
    const st = newGame(western, 2);
    const added = applyGmActions(st, [add(simRule(), 'review')], env(western));
    expect(added.gmSkipped).toEqual([]);
    expect(ids(added.state)).toContain(simRule().id);
    const entry = added.state.activeRules!.find((e) => e.rule.id === simRule().id)!;
    expect(entry).toMatchObject({ source: 'gm', since: { area: 0, turn: st.turn }, reason: 'review' });
    expect(added.state.area.gmBudget).toBe(st.area.gmBudget - GM_ACTION_COST.add_rule);
    expect(added.events).toContainEqual({ type: 'rule_added', id: simRule().id, name: simRule().name, source: 'gm', reason: 'review' });
    expect(added.state.log.some((l) => l.text.startsWith(`New rule: ${simRule().name}`))).toBe(true);
    const removed = applyGmActions(added.state, [remove(simRule().id, 'review')], env(western));
    expect(ids(removed.state)).not.toContain(simRule().id);
    expect(removed.state.area.gmBudget).toBe(added.state.area.gmBudget - GM_ACTION_COST.remove_rule);
    expect(removed.events.some((e) => e.type === 'rule_removed' && e.id === simRule().id)).toBe(true);
  });

  it('a GM rule fires its player triggers; after removal it no longer does', () => {
    const w = testWorld();
    // +1 hp every 10 turns (helpful: -10 hp/100t), so retiring it is 10 hp/100t of harm: allowed on hard
    let s = createGame(w, { seed: 1, map: roomMap(), mapGenerator: simpleGenerator, difficulty: 'hard' });
    player(s).hp = 10;
    const mend = rule('mend', { playerTriggers: [{ on: 'on_turn', every: 10, chance: 1, action: { targeting: self, effects: [{ type: 'heal', amount: { base: 1 } }] } }] });
    s = applyGmActions(s, [add(mend)], env(w)).state;
    const waitN = (n: number) => {
      for (let i = 0; i < n; i++) s = act(w, s, { type: 'wait' }).state;
    };
    waitN(20);
    expect(player(s).hp).toBe(12);
    const r = applyGmActions(s, [remove('mend')], env(w));
    expect(r.gmSkipped).toEqual([]);
    s = r.state;
    waitN(20);
    expect(player(s).hp).toBe(12);
  });

  it('switches come from the live list: darkness applies when added and lifts when removed', () => {
    const w = testWorld();
    let s = newGame(w);
    const sight = playerSheet(s, env(w)).sight;
    // darkness 0.5 is ~4 hp/100t of harm: within the normal allowance
    s = applyGmActions(s, [add(rule('dusk', { switches: { darkness: 0.5 } }))], env(w)).state;
    expect(playerSheet(s, env(w)).sight).toBe(Math.round(sight * 0.5));
    s = applyGmActions(s, [remove('dusk')], env(w)).state;
    expect(playerSheet(s, env(w)).sight).toBe(sight);
  });

  it('durability added mid-run starts wearing held gear; removing it leaves no counters behind', () => {
    const w = testWorld();
    let s = newGame(w);
    const stick = () => leadPlayer(s).slots.find((x) => x?.defId === 'stick')!;
    expect(stick().durability).toBeUndefined();
    s = applyGmActions(s, [add(rule('rust', { switches: { durability: true } }))], env(w)).state;
    expect(typeof stick().durability).toBe('number');
    s = applyGmActions(s, [remove('rust')], env(w)).state;
    expect(stick().durability).toBeUndefined();
  });

  it('GM rules survive save and load', () => {
    const w = testWorld();
    const s = applyGmActions(newGame(w), [add(simRule(), 'why')], env(w)).state;
    const back = deserialize(w, serialize(s));
    expect(back.activeRules).toEqual(s.activeRules);
    expect(back.difficulty).toBe('normal');
  });

  it('states from before activeRules play with the world rules and can still take GM rules', () => {
    const w = testWorld((x) => {
      x.rules = [{ id: 'old', name: 'Old', description: 'd', playerTriggers: [], switches: { darkness: 0.5 } }];
    });
    const s = newGame(w);
    const legacy = structuredClone(s);
    delete legacy.activeRules;
    delete legacy.difficulty;
    const sight = playerSheet(legacy, env(w)).sight;
    expect(sight).toBe(playerSheet(s, env(w)).sight);
    const r = applyGmActions(legacy, [add(simRule())], env(w));
    expect(ids(r.state)).toEqual(['old', simRule().id]);
  });
});

describe('add_rule / remove_rule limits', () => {
  it('at most one new GM rule per area; the next area allows another', () => {
    const w = testWorld();
    let s = newGame(w);
    const r = applyGmActions(s, [add(rule('a')), add(rule('b'))], env(w));
    expect(ids(r.state)).toEqual(['a']);
    expect(r.gmSkipped).toEqual([{ action: 'add_rule', reason: 'at most 1 new rule per area' }]);
    s = r.state;
    s.area.gmRulesAdded = 0; // as on entering a new area (enterArea builds a fresh AreaState)
    expect(ids(applyGmActions(s, [add(rule('b'))], env(w)).state)).toEqual(['a', 'b']);
  });

  it(`at most ${MAX_ACTIVE_RULES} rules in force`, () => {
    // worlds start with at most 3 rules; the GM fills the rest, one per area
    const w = testWorld((x) => {
      x.rules = ['w1', 'w2', 'w3'].map((id) => ({ id, name: id, description: 'd', playerTriggers: [], switches: {} }));
    });
    let s = newGame(w);
    for (const id of ['g1', 'g2', 'g3']) {
      s.area.gmRulesAdded = 0; // a new area
      s.area.gmBudget = GM_BUDGET_PER_AREA;
      const r = applyGmActions(s, [add(rule(id))], env(w));
      if (id === 'g3') {
        expect(r.gmSkipped![0].reason).toMatch(/at most 5 rules/);
        expect(r.state.area.gmBudget).toBe(GM_BUDGET_PER_AREA);
      }
      s = r.state;
    }
    expect(ids(s)).toEqual(['w1', 'w2', 'w3', 'g1', 'g2']);
    expect(ids(s)).toHaveLength(MAX_ACTIVE_RULES);
  });

  it('duplicate ids, malformed rules and unknown references are refused', () => {
    const w = testWorld();
    const s = applyGmActions(newGame(w), [add(rule('a'))], env(w)).state;
    s.area.gmRulesAdded = 0;
    const bad = [
      add(rule('a')),
      { type: 'add_rule', rule: { id: 'Not An Id!', name: 'x' }, reason: 'x' } as unknown as GmAction,
      add(rule('ghost', { playerTriggers: [{ on: 'on_turn', every: 5, chance: 1, action: { targeting: self, effects: [{ type: 'apply_status', status: 'nope', duration: 2 }] } }] })),
      add(rule('nores', { playerTriggers: [{ on: 'on_turn', every: 5, chance: 1, action: { targeting: self, effects: [{ type: 'resource', resource: 'nope', amount: { base: 1 } }] } }] })),
      remove('never-was'),
    ];
    const r = applyGmActions(s, bad, env(w));
    expect(r.gmSkipped!.map((x) => x.reason)).toEqual([
      'rule "a" is already in force',
      expect.stringMatching(/^malformed rule/),
      'unknown status "nope"',
      'unknown resource "nope"',
      'no rule "never-was" in force',
    ]);
    expect(ids(r.state)).toEqual(['a']);
    expect(r.state.area.gmBudget).toBe(s.area.gmBudget);
  });

  it('the harm a rule may add scales with difficulty (gentle needs a counterweight)', () => {
    const w = testWorld();
    // 1 fire damage every 10 turns = 10 hp per 100 turns
    const harsh = burnRule('embers', 1, 10);
    expect(estimateRuleImpact(w, harsh).hpPer100).toBe(10);
    const accepted = (difficulty: GameState['difficulty']) => {
      const s = createGame(w, { seed: 1, map: roomMap(), mapGenerator: simpleGenerator, difficulty });
      return ids(applyGmActions(s, [add(harsh)], env(w)).state).includes('embers');
    };
    expect([accepted('gentle'), accepted('normal'), accepted('hard'), accepted('brutal')]).toEqual([false, false, true, true]);
    // with a counterweight in the same rule the net harm is ~0: allowed even on gentle
    const balanced = rule('embers-and-ash', {
      playerTriggers: [harsh.playerTriggers[0], { on: 'on_turn', every: 10, chance: 1, action: { targeting: self, effects: [{ type: 'heal', amount: { base: 1 } }] } }],
    });
    const s = createGame(w, { seed: 1, map: roomMap(), mapGenerator: simpleGenerator, difficulty: 'gentle' });
    const r = applyGmActions(s, [add(balanced)], env(w));
    expect(r.gmSkipped).toEqual([]);
    expect(ids(r.state)).toContain('embers-and-ash');
  });

  it('retiring a strongly helpful rule counts as harm', () => {
    const w = testWorld((x) => {
      x.rules = [{ id: 'mercy', name: 'Mercy', description: 'd', playerTriggers: [], switches: { permadeathMercy: true } }];
    });
    // permadeathMercy is worth hp/3 = 10 hp: removing it is harm 10, beyond the normal allowance
    const r = applyGmActions(newGame(w), [remove('mercy')], env(w));
    expect(ids(r.state)).toEqual(['mercy']);
    expect(r.gmSkipped![0].reason).toMatch(/too harsh for normal/);
    const brutal = createGame(w, { seed: 1, map: roomMap(), mapGenerator: simpleGenerator, difficulty: 'brutal' });
    expect(ids(applyGmActions(brutal, [remove('mercy')], env(w)).state)).toEqual([]);
  });

  it('GM rules are limited in total harm, not only one by one', () => {
    const w = testWorld();
    let s = createGame(w, { seed: 1, map: roomMap(), mapGenerator: simpleGenerator, difficulty: 'normal' });
    // 5 hp/100t each: each is within the per-rule allowance (6), two are within the total (10), three are not
    for (const id of ['r1', 'r2', 'r3']) {
      s = applyGmActions(s, [add(burnRule(id, 1, 20))], env(w)).state;
      s.area.gmRulesAdded = 0;
    }
    expect(ids(s)).toEqual(['r1', 'r2']);
  });
});

describe('refused GM actions stay out of the player log', () => {
  it('over-budget and unsupported actions become gm_skipped events only', () => {
    const w = testWorld();
    const s = newGame(w);
    const r = applyGmActions(s, [...Array.from({ length: 4 }, () => ({ type: 'spawn', actor: 'rat', count: 1, near: 'random' }) as GmAction)], env(w));
    expect(r.gmSkipped).toEqual([{ action: 'spawn', reason: 'over budget' }]);
    expect(r.state.log.some((l) => /skipped|over budget/.test(l.text))).toBe(false);
  });
});

describe('GM budget: action types that are Object.prototype keys', () => {
  const western: WorldSpec = loadFixture('fixture-western.json');

  it('a malformed offer option cannot turn the area GM budget into NaN (through GameSession.applyGm)', () => {
    const s = new GameSession({ world: western, worldId: 'review', seed: 3, map: roomMap(16, 12) });
    const bad = {
      type: 'offer_choice',
      prompt: 'x',
      options: [
        { label: 'a', actions: [{ type: 'constructor' }] },
        { label: 'b', actions: [{ type: 'grant_xp', amount: 1 }] },
      ],
    } as unknown as GmAction;
    s.applyGm([bad]);
    expect(Number.isFinite(s.state.area.gmBudget)).toBe(true);
  });

  it('…and the per-area budget still caps spawns afterwards', () => {
    const st = newGame(western, 5);
    const hostile = western.actors.find((a) => a.faction === 'hostile' && !a.npc && !a.unique)!;
    const bad = { type: 'offer_choice', prompt: 'x', options: [{ label: 'a', actions: [{ type: 'toString' }] }] } as unknown as GmAction;
    const spawns: GmAction[] = Array.from({ length: 8 }, () => ({ type: 'spawn', actor: hostile.id, count: 1, near: 'random' }) as GmAction);
    const r = applyGmActions(st, [bad, ...spawns], env(western));
    expect(Number.isFinite(r.state.area.gmBudget)).toBe(true);
    expect(r.state.area.actors.length - st.area.actors.length).toBeLessThanOrEqual(3);
  });

  it('top-level inherited keys are unknown types; an option with one is left out whole', () => {
    const w = testWorld();
    const s = newGame(w);
    const r = applyGmActions(
      s,
      [
        { type: 'constructor' } as unknown as GmAction,
        { type: '__proto__' } as unknown as GmAction,
        { type: 'offer_choice', prompt: 'p', options: [{ label: 'bad', actions: [{ type: 'hasOwnProperty' }, { type: 'grant_xp', amount: 1 }] }, { label: 'ok', actions: [{ type: 'grant_xp', amount: 1 }] }] } as unknown as GmAction,
      ],
      env(w),
    );
    expect(r.gmSkipped!.slice(0, 2)).toEqual([
      { action: 'action', reason: 'unknown type' },
      { action: 'action', reason: 'unknown type' },
    ]);
    expect(leadPlayer(r.state).pendingChoice?.options.map((o) => o.label)).toEqual(['ok']);
    // offer (1) + grant_xp reserved (2)
    expect(r.state.area.gmBudget).toBe(GM_BUDGET_PER_AREA - 3);
  });

  it('a step after a GM batch keeps a finite budget', () => {
    const w = testWorld();
    const s = applyGmActions(newGame(w), [{ type: 'offer_choice', prompt: 'p', options: [{ label: 'a', actions: [{ type: 'valueOf' }] }, { label: 'b', actions: [] }] } as unknown as GmAction], env(w)).state;
    expect(Number.isFinite(step(s, { type: 'wait' }, env(w)).state.area.gmBudget)).toBe(true);
  });
});
