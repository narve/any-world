import { describe, it, expect } from 'vitest';
import { createGame, applyGmActions, step, leadPlayer, patchPlayer } from '../../src/engine';
import type { GameState } from '../../src/engine/types';
import { loadFixture, roomMap } from '../engine/helpers';
import { gameView, type GameViewExtras } from '../../src/client/view';
import { computeLayer, type LayerState } from '../../src/client/ui/input';

// Regression for issues/M1-choice-perk-softlock.md: a GM offer_choice landing while a
// perk choice is pending used to route the keyboard to a choice the engine rejects.

const w = loadFixture('fixture-western.json');
const extras = (o: Partial<GameViewExtras> = {}): GameViewExtras => ({ gmLog: [], narration: null, mode: 'normal', dialogueHistory: [], tradeOpen: false, ...o });
const layerOf = (s: GameState, x = extras()) => {
  const v = gameView(w, s, x);
  const ls: LayerState = {
    screen: 'game', settingsOpen: false, helpOpen: false, rulesOpen: false, backpackOpen: false, menuOpen: false, narrationVisible: false,
    choice: !!v.choice, levelUp: !!v.levelUp, dialogue: !!v.dialogue, trade: !!v.trade, mode: 'normal',
  };
  return { v, layer: computeLayer(ls) };
};

function offerOverPerk(): GameState {
  const s0 = createGame(w, { seed: 1, map: roomMap() });
  const r = applyGmActions(s0, [
    { type: 'grant_xp', amount: 200 },
    { type: 'offer_choice', prompt: 'Pick', options: [{ label: 'A', actions: [] }, { label: 'B', actions: [] }] },
  ] as never);
  return r.state;
}

describe('GM offer arriving while a perk choice is pending', () => {
  it('routes input to the level-up first and the offer afterwards', () => {
    const s = offerOverPerk();
    expect(leadPlayer(s).pendingPerkChoice?.length).toBeGreaterThan(0);
    expect(leadPlayer(s).pendingChoice?.kind).toBe('gm_offer');

    const a = layerOf(s);
    expect(a.layer).toBe('levelup');
    expect(a.v.levelUp).not.toBeNull();
    expect(a.v.choice).toBeNull(); // nothing may cover the level-up modal

    // the engine accepts what the level-up layer sends (200 xp may be several levels)
    let cur = s;
    for (let i = 0; i < 20 && leadPlayer(cur).pendingPerkChoice; i++) {
      const v = gameView(w, cur, extras());
      expect(layerOf(cur).layer).toBe('levelup');
      expect(v.choice).toBeNull();
      const r = step(cur, { type: 'choose_perk', perkId: v.levelUp!.perks[0].id });
      expect(JSON.stringify(r)).not.toMatch(/choose a perk first/);
      expect(r.state).not.toBe(cur);
      cur = r.state;
    }
    const r1 = { state: cur };
    expect(leadPlayer(r1.state).pendingPerkChoice ?? null).toBeNull();

    // the GM offer is still open and now reachable
    const b = layerOf(r1.state);
    expect(b.layer).toBe('choice');
    expect(b.v.choice?.options.map((o) => o.label)).toEqual(['A', 'B']);
    const r2 = step(r1.state, { type: 'choose_option', index: 0 });
    expect(leadPlayer(r2.state).pendingChoice ?? null).toBeNull();
  });

  it('computeLayer ranks levelup above choice', () => {
    const base: LayerState = {
      screen: 'game', settingsOpen: false, helpOpen: false, rulesOpen: false, backpackOpen: false, menuOpen: false, narrationVisible: false,
      choice: true, levelUp: true, dialogue: true, trade: true, mode: 'normal',
    };
    expect(computeLayer(base)).toBe('levelup');
    expect(computeLayer({ ...base, levelUp: false })).toBe('choice');
  });

  it('also hides dialogue/trade panels while a perk is pending', () => {
    const s = offerOverPerk();
    const d: GameState = patchPlayer(s, { pendingChoice: { kind: 'dialogue', prompt: 'Hi', options: [{ label: 'Bye', actions: [] }] } });
    const { v, layer } = layerOf(d, extras({ tradeOpen: true }));
    expect(layer).toBe('levelup');
    expect(v.dialogue).toBeNull();
    expect(v.trade).toBeNull();
    expect(v.choice).toBeNull();
  });
});
