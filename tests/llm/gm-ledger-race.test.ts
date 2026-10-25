/**
 * Regression test for review M5 round 2 (issues/M5-help-ledger-race.md): the GM director and the
 * NPC voice share one help ledger; both used to read it before awaiting the model, so two
 * requests in flight together each spent the full area ceiling.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorld } from '../../src/schema/refs';
import type { WorldSpec } from '../../src/schema/world';
import type { GmAction } from '../../src/schema/gm';
import { LlmGmDirector, LlmDialogue } from '../../src/llm/gm-runtime';
import { isHelpfulAction } from '../../src/llm/gm-checks';
import { HELPFUL_CEILING } from '../../src/llm/prompts/gm';
import { playToSituation, npcsInArea, dialogueInputFor } from '../../src/llm/situation';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../../src/llm/types';

function fixture(name: string): WorldSpec {
  const r = parseWorld(JSON.parse(readFileSync(`content/worlds/${name}.json`, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.world;
}

/** answers every request with two grant_xp after `release()` is called */
function gatedProvider(): { provider: LLMProvider; release: () => void; started: () => number } {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let n = 0;
  const provider: LLMProvider = {
    id: 'gated',
    model: 'gated',
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      n++;
      await gate;
      const xp = [{ type: 'grant_xp', amount: 10 }, { type: 'grant_xp', amount: 10 }];
      const body = req.purpose.startsWith('dialogue') ? { reply: 'Here, take this.', options: [], actions: xp, end: false } : { actions: xp };
      return { text: JSON.stringify(body), model: 'gated', stopReason: 'end' } as CompletionResponse;
    },
  };
  return { provider, release: () => open(), started: () => n };
}

describe('shared help ledger under concurrency', () => {
  it('a GM moment and an NPC voice turn in flight together stay within the area ceiling', async () => {
    const world = fixture('fixture-western');
    let sit = null as ReturnType<typeof playToSituation> | null;
    for (let seed = 1; seed <= 30 && !sit; seed++) {
      for (let area = 0; area < world.areas.length && !sit; area++) {
        const s = playToSituation(world, { seed, area, turnsInArea: 3 });
        if (s.reached && npcsInArea(world, s.state).length) sit = s;
      }
    }
    expect(sit).not.toBeNull();
    const { provider, release, started } = gatedProvider();
    const director = new LlmGmDirector({ provider, onError: () => undefined });
    const dialogue = new LlmDialogue({ provider, ledger: director.ledger, onError: () => undefined });
    const npc = npcsInArea(world, sit!.state)[0]!;
    const gm = director.respond({
      id: 1,
      hook: 'idle',
      area: sit!.state.area.index,
      turn: sit!.state.turn,
      signal: new AbortController().signal,
      ctx: { world, state: sit!.state, difficulty: 'normal', weirdness: 0.5, recentLog: sit!.recentLog, areaEnteredTurn: sit!.areaEnteredTurn },
    });
    const talk = dialogue.turn({ ...dialogueInputFor(world, sit!, npc.id), difficulty: 'normal' });
    await new Promise((r) => setTimeout(r, 20));
    expect(started()).toBe(2);
    release();
    const [g, d] = await Promise.all([gm, talk]);
    const helpful = [...(g?.actions ?? []), ...d.response.actions].filter((a: GmAction) => isHelpfulAction(world, a, sit!.state)).length;
    expect(helpful).toBe(HELPFUL_CEILING.normal);
    expect(director.ledger.get(sit!.state)).toBe(HELPFUL_CEILING.normal);
  });
});
