/**
 * Review M5 round 3 (code): GM fiat through a stale snapshot. LlmGmDirector checks the model's
 * actions (goal protection, "damage that could knock the player out", engine dry run) against the
 * snapshot the request was made from (GmContext.state). The answer can arrive up to 20 s later
 * (DEFAULT_GM_DEADLINE_MS), and the game never blocks on it, so the player keeps playing; the
 * GmRunner only drops answers when the AREA changed (epoch), and GameController.onGmResult /
 * GameSession.applyGm apply the actions to the CURRENT state through engine applyGmActions, which
 * runs none of the gm-checks. A player-damage effect that was "safe" at the snapshot's hp is then
 * lethal: the GM loses the run by fiat, which round 2's fix was meant to rule out.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import type { GameState } from '../../src/engine/types';
import { LlmGmDirector } from '../../src/llm/gm-runtime';
import { playToSituation } from '../../src/llm/situation';
import { GameSession } from '../../src/client/session';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../../src/llm/types';
import { leadPlayer } from '../../src/engine';

function fixture(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

function provider(body: object): LLMProvider {
  return {
    id: 'fixed',
    model: 'fixed',
    async complete(_req: CompletionRequest): Promise<CompletionResponse> {
      return { text: JSON.stringify(body), model: 'fixed', stopReason: 'end' } as CompletionResponse;
    },
  };
}

describe('GM answer checked against the request snapshot, applied to a later state', () => {
  it('a player-damage effect accepted at the snapshot hp does not knock the player out a few turns later', async () => {
    const world = fixture('fixture-western');
    const sit = playToSituation(world, { seed: 2, area: 0, turnsInArea: 2 });
    expect(sit.reached).toBe(true);
    const snap = sit.state;
    const pl = snap.area.actors.find((a) => a.id === leadPlayer(snap).actorId)!;
    // the largest "non-lethal" damage the checks allow at this hp (and within GM_AMOUNT_LIMIT)
    const dmg = Math.min(50, pl.hp - 1);
    expect(dmg).toBeGreaterThan(3);
    const director = new LlmGmDirector({
      provider: provider({ actions: [{ type: 'effect', target: 'player', effects: [{ type: 'resource', resource: 'hp', amount: { base: -dmg } }] }] }),
      fallback: null,
      onError: () => undefined,
    });
    const res = await director.respond({
      id: 1,
      hook: 'idle',
      area: snap.area.index,
      turn: snap.turn,
      signal: new AbortController().signal,
      ctx: { world, state: snap, difficulty: 'normal', weirdness: 0.5, recentLog: sit.recentLog, areaEnteredTurn: sit.areaEnteredTurn },
    });
    // accepted: at the snapshot the player survives it
    expect(res?.actions.length).toBe(1);

    // meanwhile (the request took a few seconds) the player took a couple of hits in the same area
    const s = new GameSession({ world, worldId: 'fixture-western', seed: 2 });
    const later = structuredClone(snap) as GameState;
    later.turn += 4;
    later.area.actors.find((a) => a.id === leadPlayer(later).actorId)!.hp = Math.max(1, pl.hp - 6);
    s.state = later;
    s.narration = null;

    // the controller applies it as is (same area, so not stale for GmRunner / onGmResult)
    s.applyGm(res!.actions, { hook: 'idle', area: snap.area.index });
    expect(s.state.status).toBe('playing');
  });
});

describe('GM re-checks on apply (issues/M5-stale-gm-fiat.md)', () => {
  const world = fixture('fixture-western');
  const lethal = (n: number) => ({ type: 'effect', target: 'player', effects: [{ type: 'resource', resource: 'hp', amount: { base: -n } }] }) as never;

  function session(): GameSession {
    const s = new GameSession({ world, worldId: 'fixture-western', seed: 2 });
    s.narration = null;
    return s;
  }

  it('keeps the safe actions of an answer and drops the one that would now be lethal', () => {
    const s = session();
    const hp = s.state.area.actors.find((a) => a.id === leadPlayer(s.state).actorId)!.hp;
    const before = s.state.purse;
    s.applyGm([lethal(hp + 5), { type: 'currency', amount: 7 } as never], { hook: 'idle', area: s.state.area.index });
    expect(s.state.status).toBe('playing');
    expect(s.state.area.actors.find((a) => a.id === leadPlayer(s.state).actorId)!.hp).toBe(hp);
    expect(s.state.purse).toBe(before + 7);
  });

  it('cumulative damage across actions is checked against the running result', () => {
    const s = session();
    const hp = s.state.area.actors.find((a) => a.id === leadPlayer(s.state).actorId)!.hp;
    const half = Math.ceil(hp / 2) + 1;
    s.applyGm([lethal(half), lethal(half)], { hook: 'idle', area: s.state.area.index });
    expect(s.state.status).toBe('playing');
    expect(s.state.area.actors.find((a) => a.id === leadPlayer(s.state).actorId)!.hp).toBe(hp - half);
  });

  it('trusted (debug) applications are not re-checked', () => {
    const s = session();
    const hp = s.state.area.actors.find((a) => a.id === leadPlayer(s.state).actorId)!.hp;
    s.applyGm([lethal(hp + 5)], { hook: 'idle', area: s.state.area.index, trusted: true });
    expect(s.state.status).toBe('lost');
  });

  it('an offer option is re-checked when the player picks it', () => {
    const s = session();
    const st = structuredClone(s.state) as GameState;
    const pl = st.area.actors.find((a) => a.id === leadPlayer(st).actorId)!;
    pl.hp = 3;
    leadPlayer(st).pendingChoice = { kind: 'gm_offer', prompt: 'A deal?', options: [{ label: 'Take it', actions: [lethal(2), { type: 'currency', amount: 5 } as never] }, { label: 'No', actions: [] }] };
    s.state = st;
    // safe when offered (hp 3, loss 2); the player is then hit down to 2 before choosing
    s.state.area.actors.find((a) => a.id === leadPlayer(s.state).actorId)!.hp = 2;
    const cur = s.state.purse;
    s.act({ type: 'choose_option', index: 0 });
    expect(s.state.status).toBe('playing');
    expect(leadPlayer(s.state).pendingChoice).toBeNull();
    expect(s.state.purse).toBe(cur + 5);
  });
});
