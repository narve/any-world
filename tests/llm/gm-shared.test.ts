/**
 * MP4 G1, the shared GM pieces in src/llm: the help ceiling scaled for a party (helpCeiling, the
 * same for one player as HELPFUL_CEILING), a ledger behind an interface (HelpLedgerLike: a room
 * backs it with its tracker), and injected timers in LlmGmDirector (the model's deadline) and the
 * MockProvider (seeded latency), so room tests run on a manual clock.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import type { Difficulty, GmAction } from '../../src/schema/gm';
import type { GameState } from '../../src/engine/types';
import { HELPFUL_CEILING, helpCeiling, gmUserMessage } from '../../src/llm/prompts/gm';
import { dialogueUserMessage } from '../../src/llm/prompts/dialogue';
import { capResponse, HelpLedger, LlmGmDirector, type HelpLedgerLike } from '../../src/llm/gm-runtime';
import { MockProvider } from '../../src/llm/mock';
import { gmResponseErrors, keepValidActions } from '../../src/llm/gm-checks';
import { gmInputFor, playToSituation, npcsInArea, dialogueInputFor } from '../../src/llm/situation';
import type { GmContext, GmRequest } from '../../src/gm/offline';

function fixture(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

/** a manual clock: timers fire only when the test advances it */
function manualTimers() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn: () => void, ms: number): unknown => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h: unknown) => void timers.delete(h as number),
    delays: () => [...timers.values()].map((t) => t.at - now),
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        timers.delete(id);
        t.fn();
      }
    },
    get size() {
      return timers.size;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const ship = fixture('fixture-ship');
const sit = playToSituation(ship, { seed: 3, area: 0, turnsInArea: 25 });

function req(state: GameState, hook: GmRequest['hook'] = 'idle', difficulty: Difficulty = 'normal'): GmRequest {
  const ctx: GmContext = { world: ship, state, difficulty, weirdness: 0.5, recentLog: sit.recentLog, areaEnteredTurn: sit.areaEnteredTurn };
  return { id: 1, hook, area: state.area.index, turn: state.turn, ctx, signal: new AbortController().signal };
}

const partyOf = (s: GameState, n: number): GameState => ({ ...s, area: { ...s.area, partySize: n } });

describe('helpCeiling', () => {
  it('a party of one gets HELPFUL_CEILING; a party gets it scaled like the GM budget', () => {
    for (const d of ['gentle', 'normal', 'hard', 'brutal'] as const) {
      expect(helpCeiling(d)).toBe(HELPFUL_CEILING[d]);
      expect(helpCeiling(d, 1)).toBe(HELPFUL_CEILING[d]);
    }
    expect(helpCeiling('normal', 4)).toBe(4);
    expect(helpCeiling('hard', 4)).toBe(2);
    expect(helpCeiling('normal', 12)).toBe(8);
    expect(helpCeiling('gentle', 2)).toBe(4);
  });

  it('the prompts quote the party ceiling from state.area.partySize', () => {
    expect(gmUserMessage(gmInputFor(ship, sit, 'idle'))).toContain('HELP USED this area: 0 of 2');
    const party = { ...sit, state: partyOf(sit.state, 4) };
    expect(gmUserMessage(gmInputFor(ship, party, 'idle'))).toContain('HELP USED this area: 0 of 4');
    const teen = fixture('fixture-teen');
    const s2 = playToSituation(teen, { seed: 1, area: 0, turnsInArea: 0 });
    const npc = npcsInArea(teen, s2.state)[0]!;
    const input = dialogueInputFor(teen, { ...s2, state: partyOf(s2.state, 4) }, npc.defId);
    expect(dialogueUserMessage(input)).toContain('HELP USED this area: 0 of 4');
  });

  it('capResponse caps help at the party ceiling, charged to any HelpLedgerLike', () => {
    const coins = (n: number) => ({ type: 'currency', amount: n }) as GmAction;
    const four = [coins(1), coins(2), coins(3), coins(4)];
    let used = 0;
    const ledger: HelpLedgerLike = { get: () => used, add: (_s, n) => void (used += n) };
    expect(capResponse(ledger, req(sit.state), four)?.actions).toEqual(four.slice(0, 2));
    expect(used).toBe(2);
    used = 0;
    expect(capResponse(ledger, req(partyOf(sit.state, 4)), four)?.actions).toEqual(four);
    expect(used).toBe(4);
    // the class implements the interface
    const l: HelpLedgerLike = new HelpLedger();
    l.add(sit.state, 1);
    expect(l.get(sit.state)).toBe(1);
  });
});

describe('injected timers', () => {
  it('MockProvider: seeded latency on the injected timers', async () => {
    const draws = (seed: number) => {
      const t = manualTimers();
      const p = new MockProvider({ responses: { gm: '{"actions":[]}' }, latencyMs: [20, 600], seed, setTimer: t.set, clearTimer: t.clear });
      const out: number[] = [];
      for (let i = 0; i < 4; i++) {
        void p.complete({ system: '', messages: [], purpose: 'gm:idle' });
        out.push(t.delays().at(-1)!);
      }
      return out;
    };
    const a = draws(7);
    expect(draws(7)).toEqual(a);
    expect(draws(8)).not.toEqual(a);
    expect(a.every((ms) => ms >= 20 && ms <= 600)).toBe(true);

    const t = manualTimers();
    const p = new MockProvider({ responses: { gm: '{"actions":[]}' }, latencyMs: 300, setTimer: t.set, clearTimer: t.clear });
    let done = false;
    void p.complete({ system: '', messages: [], purpose: 'gm:idle' }).then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    t.advance(299);
    await flush();
    expect(done).toBe(false);
    t.advance(1);
    await flush();
    expect(done).toBe(true);
    // an abort clears the timer
    const ctrl = new AbortController();
    const q = p.complete({ system: '', messages: [], purpose: 'gm:idle', signal: ctrl.signal });
    expect(t.size).toBe(1);
    ctrl.abort();
    await expect(q).rejects.toThrow();
    expect(t.size).toBe(0);
  });

  it('LlmGmDirector: the model deadline runs on the injected timer, then the capped fallback answers', async () => {
    const t = manualTimers();
    const provider = new MockProvider({ responses: { gm: '{"actions":[{"type":"narrate","text":"late"}]}' }, latencyMs: 10_000, setTimer: t.set, clearTimer: t.clear });
    const fallback = { name: 'canned', respond: async () => ({ actions: [{ type: 'narrate', text: 'on time' }] as GmAction[] }) };
    const d = new LlmGmDirector({ provider, fallback, deadlineMs: 4000, setTimer: t.set, clearTimer: t.clear, onError: () => undefined });
    let answer: unknown;
    void d.respond(req(sit.state)).then((r) => (answer = r));
    await flush();
    expect(t.delays().sort((a, b) => a - b)).toEqual([4000, 10_000]);
    t.advance(4000);
    await flush();
    await flush();
    expect(answer).toEqual({ actions: [{ type: 'narrate', text: 'on time' }] });
    expect(t.size).toBe(0);
  });
});

describe('the room-only chat hook', () => {
  it('is words only: narrate, say and mood pass, anything else is refused', () => {
    const words: GmAction[] = [{ type: 'narrate', text: 'The wind turns.' }, { type: 'mood', mood: 'calm' } as GmAction];
    const gift = { type: 'currency', amount: 50 } as GmAction;
    expect(keepValidActions(ship, sit.state, [...words, gift], 'chat')).toEqual(words);
    expect(gmResponseErrors(ship, sit.state, { actions: [gift] }, 'chat').length).toBeGreaterThan(0);
    // the same action is fine on idle
    expect(keepValidActions(ship, sit.state, [gift], 'idle')).toEqual([gift]);
  });
});
