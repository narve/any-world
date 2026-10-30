/**
 * "Clearer controls & goals" (PLAN backlog from the Lowmoor playtest): the goal tracker's current
 * step, conditions in plain words, the context action bar (incl. a locked exit saying why), and the
 * onboarding card's world-derived lines.
 */
import { describe, expect, it } from 'vitest';
import type { GameState, Pos } from '../../src/engine/types';
import type { Condition } from '../../src/schema/world';
import { GameSession } from '../../src/client/session';
import {
  conditionLines,
  conflictLines,
  contextActions,
  currentStep,
  evalCondition,
  goalView,
  humanizeId,
  leafText,
  lockedReason,
  onboardingView,
  stepText,
  unmetLeaves,
} from '../../src/client/guide';
import { explainInvalid } from '../../src/client/invalid';
import { legalActions, leadPlayer } from '../../src/engine/index';
import { loadFixture, roomMap } from '../engine/helpers';

const teen = loadFixture('fixture-teen.json');
const western = loadFixture('fixture-western.json');

function session(world = teen): GameSession {
  const s = new GameSession({ world, worldId: 'fixture-test', seed: 3, map: roomMap(14, 10) });
  s.narration = null;
  return s;
}

/** edit the state: only the player and the given actors stay */
function edit(s: GameSession, fn: (st: GameState) => void): void {
  const st = structuredClone(s.state) as GameState;
  fn(st);
  s.state = st;
}

function placePlayer(st: GameState, pos: Pos): void {
  st.area.actors = st.area.actors.filter((a) => a.id === leadPlayer(st).actorId);
  st.area.actors[0].pos = { ...pos };
  st.area.items = [];
}

function giveItem(st: GameState, defId: string, slot = 9): void {
  leadPlayer(st).slots[slot] = { id: `test-${defId}`, defId, count: 1 };
}

describe('conditions in plain words', () => {
  it('names actors, items and the world vocabulary', () => {
    const s = session();
    const lines = conditionLines(teen, s.state, teen.goal.win);
    const text = lines.map((l) => l.text).join(' | ');
    // win = any(flag speech-delivered, all(in_area 2, mags left speechless, notebook))
    expect(lines[0]).toMatchObject({ text: 'One of these:', group: true, depth: 0 });
    expect(text).toContain('The farewell speech is given'); // goal.labels (M3 gate), shown as is
    expect(text).not.toContain('“The farewell speech is given”'); // issues/M5-goal-flag-label-double-wrapped.md
    expect(text).toContain(`Magdalena 'Mags' Calloway is ${teen.vocabulary.defeated}`);
    expect(text).toContain("You carry Junie's Speech Notebook");
    expect(text).toContain(`You reach ${teen.vocabulary.area} 3: ${teen.areas[2].name}`);
    // nested: the "all" branch is a group one level down, its parts two levels down
    const all = lines.find((l) => l.text === 'All of these:')!;
    expect(all.depth).toBe(1);
    expect(lines.filter((l) => l.depth === 2).length).toBe(3);
    expect(lines.every((l) => l.group || l.done === false)).toBe(true);
  });

  it('marks parts that are already true and shows counter progress', () => {
    const s = session();
    edit(s, (st) => {
      giveItem(st, 'speech-notebook');
      st.counters.detentions = 1;
    });
    const win = conditionLines(teen, s.state, teen.goal.win);
    // the has_item line (the story-flag line names the notebook too: "… — with Junie's Speech Notebook")
    expect(win.find((l) => l.text.includes('Speech Notebook') && !l.text.includes(' — with '))!.done).toBe(true);
    expect(win.find((l) => l.text.includes(' — with '))!.done).toBe(false);
    const lose = goalView(teen, s.state).lose;
    expect(lose[0].text).toBe(`You run out of ${teen.vocabulary.stats.hp.name}`);
    const det = lose.find((l) => l.text.startsWith('Detentions'))!;
    expect(det.text).toBe('Detentions: 3 or more');
    expect(det.now).toBe('now 1');
  });

  it('every condition type reads as a sentence, and as a next step', () => {
    const s = session(western);
    const conds: Condition[] = [
      { type: 'has_item', who: 'player', item: 'lode-key' },
      { type: 'has_item', who: 'player', item: 'lode-key', count: 3 },
      { type: 'actor_defeated', actor: 'absalom-vane' },
      { type: 'in_area', area: 1 },
      { type: 'flag', flag: 'rain-broken', value: false },
      { type: 'counter', counter: 'bounty_paid', cmp: 'lt', value: 4 },
      { type: 'turn', cmp: 'gte', value: 200 },
      { type: 'stat', who: 'player', stat: 'hp', cmp: 'gte', value: 0.5, asPercentOfMax: true },
      { type: 'chance', p: 0.25 },
    ];
    const sentences = conds.map((c) => leafText(western, s.state, c));
    const key = western.items.find((i) => i.id === 'lode-key')!.name;
    const vane = western.actors.find((a) => a.id === 'absalom-vane')!.name;
    expect(sentences).toEqual([
      `You carry ${key}`,
      `You carry 3 × ${key}`,
      `${vane} is ${western.vocabulary.defeated}`,
      `You reach ${western.vocabulary.area} 2: ${western.areas[1].name}`,
      '“rain broken” has not happened',
      'Bounty paid: less than 4',
      'Turn 200 comes',
      `Your ${western.vocabulary.stats.hp.name}: 50% or more`,
      'With luck (25% chance)',
    ]);
    expect(stepText(western, s.state, conds[0])).toMatch(/^Get /);
    expect(stepText(western, s.state, conds[1])).toMatch(/^Collect 3 × .* \(you have 0\)$/);
    expect(stepText(western, s.state, conds[2])).toBe(`${vane} must be ${western.vocabulary.defeated}`);
    expect(stepText(western, s.state, conds[3])).toBe(`Reach ${western.areas[1].name}`);
    expect(humanizeId('colours-spilled')).toBe('colours spilled');
  });

  it('evaluates what the client can know; chance is unknown', () => {
    const s = session();
    expect(evalCondition(s.state, { type: 'in_area', area: 0 })).toBe(true);
    expect(evalCondition(s.state, { type: 'chance', p: 0.5 })).toBeNull();
    expect(evalCondition(s.state, { type: 'any', of: [{ type: 'chance', p: 0.5 }, { type: 'always' }] })).toBe(true);
    expect(evalCondition(s.state, { type: 'not', cond: { type: 'in_area', area: 0 } })).toBe(false);
    expect(evalCondition(s.state, { type: 'has_item', who: 'target', item: 'x' })).toBeNull();
  });

  it('picks the branch of an "any" that is closest to done', () => {
    const s = session();
    edit(s, (st) => {
      st.area.index = 2;
      giveItem(st, 'speech-notebook');
    });
    // flag branch: 1 unmet; all-branch: only Mags left (in area 2, notebook carried) → equal; first wins
    const need = unmetLeaves(s.state, teen.goal.win);
    expect(need).toHaveLength(1);
  });
});

describe('goal tracker step', () => {
  it('explore → go to the exit once seen → take it when standing on it', () => {
    const s = session(western);
    edit(s, (st) => {
      placePlayer(st, { x: 2, y: 2 });
      leadPlayer(st).seen = new Uint8Array(leadPlayer(st).seen.length);
    });
    expect(currentStep(western, s.state)).toMatchObject({ kind: 'explore', text: `Explore ${western.areas[0].name} and find the way on` });
    edit(s, (st) => {
      const m = st.area.map;
      (leadPlayer(st).seen as Uint8Array)[m.exit.y * m.width + m.exit.x] = 1;
    });
    expect(currentStep(western, s.state).text).toBe(`Go to the way on (marked on the map): ${western.areas[0].transitionName}`);
    edit(s, (st) => placePlayer(st, st.area.map.exit));
    expect(currentStep(western, s.state)).toMatchObject({ kind: 'exit', text: `Move on: ${western.areas[0].transitionName}` });
  });

  it('a locked way on makes its requirement the step', () => {
    const s = session();
    edit(s, (st) => {
      st.area.index = 1;
      placePlayer(st, { x: 3, y: 3 });
    });
    const step = currentStep(teen, s.state);
    expect(step.kind).toBe('unlock');
    expect(step.text).toBe("Get Junie's Speech Notebook");
    expect(step.detail).toBe(`needed for: ${teen.areas[1].transitionName}`);
    expect(goalView(teen, s.state).exitNeeds?.lines[0].text).toBe("You carry Junie's Speech Notebook");
  });

  it('an open thread comes first; the last area works toward the win condition', () => {
    const s = session();
    edit(s, (st) => {
      st.quests = [{ id: 'q1', title: 'Find Theo a dry jacket', description: 'He is shivering.', complete: { type: 'always' }, reward: [], status: 'active' }];
    });
    expect(currentStep(teen, s.state)).toMatchObject({ kind: 'quest', text: 'Find Theo a dry jacket', detail: 'He is shivering.' });
    const w = session(western);
    edit(w, (st) => {
      st.area.index = western.areas.length - 1;
    });
    const step = currentStep(western, w.state);
    expect(step.kind).toBe('final');
    expect(step.text).toBe(`${western.actors.find((a) => a.id === 'absalom-vane')!.name} must be ${western.vocabulary.defeated}`);
    expect(step.detail).toBe('and 1 more thing');
  });
});

describe('context action bar', () => {
  it('locked exit: shown, but it says why instead of acting', () => {
    const s = session();
    edit(s, (st) => {
      st.area.index = 1;
      placePlayer(st, st.area.map.exit);
    });
    const vm = s.viewModel().game!;
    const exit = vm.actions!.find((a) => a.id === 'exit')!;
    expect(exit.key).toBe('>');
    expect(exit.blocked).toBe(`The way on (“${teen.areas[1].transitionName}”) is locked. First: Get Junie's Speech Notebook.`);
    expect(lockedReason(teen, s.state)).toBe("Get Junie's Speech Notebook");
    // pressing > says the same, in plain words
    const out = s.uiAction({ type: 'transition' });
    expect(out.toasts[0].text).toContain("Get Junie's Speech Notebook");
    expect(explainInvalid(teen, s.state, { type: 'transition' }, `${teen.areas[1].transitionName}: locked`)).toContain('Speech Notebook');
  });

  it('unlocked exit is the primary button', () => {
    const s = session();
    edit(s, (st) => {
      st.area.index = 1;
      placePlayer(st, st.area.map.exit);
      giveItem(st, 'speech-notebook');
    });
    const exit = s.viewModel().game!.actions!.find((a) => a.id === 'exit')!;
    expect(exit).toMatchObject({ primary: true, label: `Move on — ${teen.areas[1].transitionName}` });
    expect(exit.blocked).toBeUndefined();
  });

  it('talk next to an NPC, pick up on an item, and wait/search always', () => {
    const s = session();
    const npc = teen.actors.find((a) => a.npc && a.faction === 'friendly')!;
    edit(s, (st) => {
      placePlayer(st, { x: 5, y: 5 });
      st.area.actors.push({ ...structuredClone(s.state.area.actors[0]), id: 'npc-1', defId: npc.id, pos: { x: 6, y: 5 }, faction: 'friendly', statuses: [] });
      st.area.items = [{ item: { id: 'fl-1', defId: teen.items[0].id, count: 1 }, pos: { x: 5, y: 5 } }];
    });
    const acts = contextActions(teen, s.state, { legal: legalActions(s.state), canTransition: false });
    const ids = acts.map((a) => a.id);
    expect(ids).toContain('pickup');
    expect(ids[ids.length - 1]).toBe('wait');
    expect(ids).toContain('search');
    const talk = acts.find((a) => a.id === 'talk');
    expect(talk).toMatchObject({ label: `Talk to ${npc.name}`, key: 't', primary: true });
    expect(acts.find((a) => a.id === 'pickup')!.label).toMatch(/^Pick up /);
  });

  it('nothing while a choice or the end screen is up', () => {
    const s = session();
    edit(s, (st) => {
      st.status = 'lost';
    });
    expect(contextActions(teen, s.state, { legal: [], canTransition: false })).toEqual([]);
  });
});

describe('onboarding card', () => {
  it('describes conflict from world data: non-violent teen vs gunfight western', () => {
    const teenLines = conflictLines(teen).join(' ');
    expect(teenLines).toContain('not about violence');
    expect(teenLines).toContain(`“${teen.vocabulary.conflict}”`);
    expect(teenLines).toContain(teen.vocabulary.stats.hp.name);
    expect(teenLines).toMatch(/Persuade: /);
    const westLines = conflictLines(western).join(' ');
    expect(westLines).not.toContain('not about violence');
    expect(westLines).toContain(`“${western.vocabulary.conflict}”`);
  });

  it('carries the goal, its conditions and how the run is lost', () => {
    const v = onboardingView(teen, 'fixture-teen');
    expect(v.worldTitle).toBe(teen.meta.title);
    expect(v.goal).toBe(teen.goal.summary);
    expect(v.win[0].text).toBe('One of these:');
    expect(v.lose[0]).toContain(teen.vocabulary.stats.hp.name);
    expect(v.lose.join(' ')).toContain('Detentions');
    expect(v.verbs).toEqual({ talk: true, sneak: false, search: true, persuade: true });
  });
});
