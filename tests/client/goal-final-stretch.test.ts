/**
 * M5 desktop playtest, round 1 — unit repros for confirmed UX bugs. Each test asserts the CORRECT
 * behaviour, so a failing test is the evidence (see the browser repros in pt-desktop-r1.spec.ts).
 */
import { describe, expect, it } from 'vitest';
import type { GameState } from '../../src/engine/types';
import { GameSession } from '../../src/client/session';
import { currentStep } from '../../src/client/guide';
import { loadFixture, roomMap } from '../engine/helpers';

const teen = loadFixture('fixture-teen.json');

function session(): GameSession {
  const s = new GameSession({ world: teen, worldId: 'fixture-teen', seed: 3, map: roomMap(14, 10) });
  s.narration = null;
  return s;
}

describe('pt-desktop r1: goal tracker in the final stretch', () => {
  // Lowmoor, Day 3 with the notebook in hand: win = any(flag speech-delivered, all(day 3, Mags
  // speechless, notebook)). Both branches have one unmet leaf; the tie goes to the first listed, so the
  // tracker says 'Make “The farewell speech is given” happen' — a flag the player has no way to read
  // as an action — instead of "leave Mags speechless", which is the actual next thing to do (and is
  // also what the flag's item, the notebook, needs first).
  it('points at the concrete leaf (Mags), not at an opaque story flag', () => {
    const s = session();
    const st = structuredClone(s.state) as GameState;
    st.area.index = 2;
    st.player.slots[9] = { id: 'test-notebook', defId: 'speech-notebook', count: 1 };
    s.state = st;
    const step = currentStep(teen, s.state);
    expect(step.kind).toBe('final');
    expect(step.text).not.toMatch(/farewell speech is given/i);
    expect(step.text).toMatch(/Mags/);
  });
});
