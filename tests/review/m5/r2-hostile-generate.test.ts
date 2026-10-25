/**
 * M5 review round 2 (balance & robustness): schema-valid but hostile worlds through the full
 * generateWorld pipeline (mock provider, balance step on). Round 1 (hostile-generate.test.ts)
 * covered replies that fail validation; these replies validate, so the engine and the balance
 * sims have to cope with them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MockProvider } from '../../../src/llm/mock';
import { generateWorld, WorldGenerationError } from '../../../src/llm/generate';
import { parseWorld } from '../../../src/schema/refs';

const fixture = () => JSON.parse(readFileSync('content/worlds/fixture-western.json', 'utf8')) as Record<string, any>;

async function generate(world: unknown, timeoutMs: number, balance: { seeds: number; rounds: number; confirm: boolean; bots?: ('explorer' | 'cautious')[] } = { seeds: 2, rounds: 0, confirm: false }) {
  const text = JSON.stringify(world);
  const mock = new MockProvider({ responses: { world: [{ text }, { text }] as never } });
  const t0 = Date.now();
  try {
    const res = await generateWorld({
      provider: mock,
      prompt: 'x',
      balance,
      repairs: 1,
      balanceFeedback: 1,
      yieldToUi: async () => {},
      timeoutMs,
    });
    return { ok: true as const, res, ms: Date.now() - t0 };
  } catch (e) {
    expect(e).toBeInstanceOf(WorldGenerationError);
    return { ok: false as const, err: e as WorldGenerationError, ms: Date.now() - t0 };
  }
}

/** every non-unique, non-NPC actor summons 4 copies of itself each turn (neutral, so the player lives) */
function swarmWorld() {
  const w = fixture();
  for (const a of w.actors) {
    if (a.unique || a.npc) continue;
    a.faction = 'neutral';
    a.triggers = [{ on: 'on_turn', chance: 1, action: { effects: [{ type: 'summon', actor: a.id, count: 4 }] } }];
  }
  return w;
}

describe('schema-valid hostile worlds through generateWorld (balance on)', () => {
  it('the self-summoning swarm world is schema-valid', () => {
    expect(parseWorld(swarmWorld()).ok).toBe(true);
  });

  // Each area fills up to ~1000 actors within 5 turns and every later turn costs ~1 s of engine
  // time (measured with public step(): 975 actors, 600–1700 ms per wait). The default balancer runs
  // the bot sims synchronously, so the pipeline's own timeoutMs cannot fire until the sims end.
  it('a swarm world settles (world or typed error) close to the pipeline timeout', async () => {
    // one explorer seed (the smallest balance step) still ran 2–10 min here; default is 12 seeds x 2 bots
    const r = await generate(swarmWorld(), 10_000, { seeds: 1, rounds: 0, confirm: false, bots: ['explorer'] });
    expect(r.ms).toBeLessThan(40_000);
  }, 600_000);

  it('a world whose xp grant overflows the stack is reported, not thrown', async () => {
    const w = fixture();
    w.player.growth.curve = 1;
    w.player.growth.firstLevelXp = 5;
    w.rules[0].playerTriggers = [{ on: 'on_turn', chance: 1, action: { effects: [{ type: 'grant_xp', amount: 1_000_000_000 }] } }];
    const r = await generate(w, 120_000);
    if (r.ok) expect(r.res.report?.verdict).toBe('broken');
    else expect(['unbalanced', 'invalid']).toContain(r.err.kind);
  }, 300_000);
});
