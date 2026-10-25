/**
 * issues/M5-goal-route-items-unseen.md: items in an earlier area that an alternate way to win needs
 * are named by the goal tracker while the player can still pick them up (there is no backtracking),
 * the final stretch prefers the branch the player already holds the means for, and the "How to win"
 * lines put the source item next to an opaque story flag.
 */
import { describe, expect, it } from 'vitest';
import type { GameState } from '../../src/engine/types';
import { GameSession } from '../../src/client/session';
import { conditionLines, currentStep, flagSource, inHand, routeItemsHere } from '../../src/client/guide';
import { playToSituation } from '../../src/llm/situation';
import { loadFixture, roomMap } from '../engine/helpers';

const heist = loadFixture('heist-silent-vault.json');
const kitchen = loadFixture('corporate-merger-kitchen.json');
const whale = loadFixture('deep-sea-whale-fall.json');

function inArea(world: typeof heist, area: number, seed = 3): GameState {
  const sit = playToSituation(world, { seed, area });
  expect(sit.reached).toBe(true);
  return sit.state;
}

function give(state: GameState, defId: string): GameState {
  const st = structuredClone(state) as GameState;
  const free = st.player.slots.findIndex((x, i) => i >= 8 && !x);
  st.player.slots[free] = { id: `test-${defId}`, defId, count: 1 };
  st.area.items = st.area.items.filter((f) => f.item.defId !== defId);
  return st;
}

describe('Pianissimo: the encore route item in area 3', () => {
  it('the encore flag can only be set by an item placed in area 3 (precondition)', () => {
    expect(flagSource(heist, 'encore-called')).toEqual(expect.objectContaining({ kind: 'item', id: 'prompters-last-cue' }));
    expect(heist.areas[2].placedItems?.some((p) => p.item === 'prompters-last-cue')).toBe(true);
  });

  it("the goal step in area 3 names The Prompter's Last Cue (the win route item lying there)", () => {
    const st = inArea(heist, 2);
    expect(st.area.items.some((f) => f.item.defId === 'prompters-last-cue')).toBe(true);
    const step = currentStep(heist, st);
    expect(step.kind).not.toBe('final');
    expect(`${step.text} ${step.detail ?? ''}`).toMatch(/Prompter's Last Cue/);
    expect(step.detail).toMatch(/^then: .*· Also here: The Prompter's Last Cue \(for: /);
  });

  it('once the cue is carried (or the area holds none) the line goes away', () => {
    const st = give(inArea(heist, 2), 'prompters-last-cue');
    expect(routeItemsHere(heist, st)).toEqual([]);
    expect(currentStep(heist, st).detail ?? '').not.toMatch(/Also here/);
    const area1 = inArea(heist, 0);
    expect(routeItemsHere(heist, area1)).toEqual([]);
  });

  it('How to win puts the cue next to the opaque encore flag', () => {
    const lines = conditionLines(heist, undefined, heist.goal.win).map((l) => l.text);
    expect(lines.some((l) => /— with The Prompter's Last Cue$/.test(l))).toBe(true);
  });

  it('the old area-index hack (GameSession) keeps working without throwing', () => {
    const s = new GameSession({ world: heist, worldId: 'heist-silent-vault', seed: 3, map: roomMap(14, 10) });
    const st = structuredClone(s.state) as GameState;
    st.area.index = 2;
    expect(() => currentStep(heist, st)).not.toThrow();
  });
});

describe('Neutral Ground: the rumour the forged agenda needs', () => {
  it('The Grapevine names the rumour lying there', () => {
    const st = inArea(kitchen, 2);
    const here = routeItemsHere(kitchen, st);
    if (!st.area.items.some((f) => f.item.defId === 'rumour-og')) return; // the bot picked it up
    expect(here.map((r) => r.item)).toContain('rumour-og');
    expect(currentStep(kitchen, st).detail).toMatch(/Also here: Rumour: Who O\.G\. Was/);
  });
});

describe("Whale Fall: the final stretch prefers the Kill Code the player carries", () => {
  it('a flag whose item is in the bag (target check aside) is in hand', () => {
    const st = give(inArea(whale, 3), 'harrow-kill-code');
    expect(inHand(whale, st, { type: 'flag', flag: 'harrow-silenced' })).toBe(true);
    const step = currentStep(whale, st);
    expect(step.kind).toBe('final');
    expect(step.text).toMatch(/Kill Code/);
    expect(step.text).not.toMatch(/driven off/);
  });

  it('without the code, the step points at getting it while it lies in the area', () => {
    const st = inArea(whale, 3);
    expect(inHand(whale, st, { type: 'flag', flag: 'harrow-silenced' })).toBe(false);
    const step = currentStep(whale, st);
    expect(`${step.text} ${step.detail ?? ''}`).toMatch(/Kill Code/);
  });
});
