/**
 * issues/M1-toast-pileup.md — refused actions must say why and what to do, in the world's words.
 * While Lassoed (rooted) the engine only says "you cannot move"; the player kept pressing move keys
 * because nothing told them waiting ends it.
 */
import { describe, it, expect } from 'vitest';
import type { GameState } from '../../src/engine/types';
import { GameSession } from '../../src/client/session';
import { explainInvalid } from '../../src/client/invalid';
import { loadFixture, roomMap } from '../engine/helpers';

const western = loadFixture('fixture-western.json');
const teen = loadFixture('fixture-teen.json');

function session(world = western, seed = 1) {
  const s = new GameSession({ world, worldId: 'fixture-test', seed, map: roomMap(14, 10) });
  s.dismissNarration('intro');
  return s;
}

function withStatus(s: GameSession, id: string, turnsLeft: number): void {
  const st = structuredClone(s.state) as GameState;
  st.area.actors.find((a) => a.id === st.player.actorId)!.statuses.push({ id, turnsLeft });
  s.state = st;
}

/** the player alone in the middle of the room, optionally with one hostile actor east of them */
function setup(s: GameSession, withHostile: boolean): string | null {
  const st = structuredClone(s.state) as GameState;
  const pid = st.player.actorId;
  const hostile = withHostile ? st.area.actors.find((a) => a.id !== pid && a.faction === 'hostile') : undefined;
  if (withHostile && !hostile) throw new Error('fixture area has no hostile actor');
  st.area.actors = st.area.actors.filter((a) => a.id === pid || a.id === hostile?.id);
  st.area.actors.find((a) => a.id === pid)!.pos = { x: 5, y: 5 };
  if (hostile) hostile.pos = { x: 6, y: 5 };
  s.state = st;
  return hostile?.id ?? null;
}

describe('refused actions explain themselves', () => {
  it('rooted: names the status, the turns left and that waiting ends it', () => {
    const s = session();
    setup(s, false);
    withStatus(s, 'lassoed', 1);
    const out = s.uiAction({ type: 'move', dir: 'n' });
    expect(out.changed).toBe(false);
    expect(out.toasts).toHaveLength(1);
    expect(out.toasts[0].text).toBe('Lassoed (1 turn left): you cannot move — wait (.) to let it pass.');
    // and the advice is right: waiting lets it run out, then moving works
    s.uiAction({ type: 'wait' });
    expect(s.uiAction({ type: 'move', dir: 'n' }).changed).toBe(true);
  });

  it('uses the world\'s own status names (teen fixture: "Written Up")', () => {
    const s = session(teen, 3);
    setup(s, false);
    withStatus(s, 'grounded', 3);
    const out = s.uiAction({ type: 'move', dir: 's' });
    expect(out.toasts[0].text).toBe('Written Up (3 turns left): you cannot move — wait (.) to let it pass.');
  });

  it('afraid: names the status and quotes the world\'s conflict verb', () => {
    const s = session();
    setup(s, true);
    withStatus(s, 'rattled', 2);
    const out = s.act({ type: 'move', dir: 'e' }); // bump the hostile = attack
    expect(out.changed).toBe(false);
    expect(out.toasts[0].text).toBe(`Rattled (2 turns left): "${western.vocabulary.conflict}" is out of the question — step away, or wait (.) to let it pass.`);
    expect(out.toasts[0].text).not.toMatch(/fight/);
  });

  it('other refusals keep the engine reason (capitalised)', () => {
    const s = session();
    setup(s, false);
    withStatus(s, 'lassoed', 2);
    // a wall is a wall, rooted or not
    expect(explainInvalid(western, s.state, { type: 'move', dir: 'n' }, 'blocked')).toBe('Blocked');
    expect(explainInvalid(western, s.state, { type: 'move', dir: 'n' }, 'make a choice first')).toBe('Make a choice first');
    // a reason that already names the status is left alone
    expect(explainInvalid(western, s.state, { type: 'move', dir: 'n' }, 'Lassoed: cannot move')).toBe('Lassoed: cannot move');
  });
});
