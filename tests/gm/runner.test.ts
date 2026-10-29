/**
 * MP4 G1: GmRunner moved to src/gm/runner.ts (the client re-exports it; its own tests in
 * tests/client/gm-director.test.ts run unchanged on the re-export). The room options: `coalesce`
 * (a newer hook about the same thing replaces a queued one; partyCoalesce) and `dropStale` (checked
 * at dequeue, before any director call), with `askedAt` from the injected clock.
 */
import { describe, it, expect } from 'vitest';
import type { GmResponse } from '../../src/schema/gm';
import { GmRunner, partyCoalesce, type GmResult } from '../../src/gm/runner';
import * as client from '../../src/client/gm-director';
import type { GmContext, GmDirector, GmHookEvent, GmRequest } from '../../src/gm/offline';

const ctx = {} as GmContext;
const hook = (h: GmHookEvent['hook'], playerId?: string, turn = 1): GmHookEvent => ({ hook: h, area: 0, turn, ...(playerId ? { detail: { playerId } } : {}) });

/** a director whose answers the test releases one by one */
function gated(): GmDirector & { asked: GmRequest[]; release(): void } {
  const waiting: (() => void)[] = [];
  const d = {
    name: 'gated',
    asked: [] as GmRequest[],
    respond(req: GmRequest): Promise<GmResponse | null> {
      d.asked.push(req);
      return new Promise((r) => waiting.push(() => r({ actions: [{ type: 'narrate', text: `${req.hook}:${req.detail?.playerId ?? '-'}:${req.turn}` }] })));
    },
    release() {
      waiting.shift()?.();
    },
  };
  return d;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('GmRunner (src/gm/runner.ts)', () => {
  it('is the class the client re-exports', () => {
    expect(client.GmRunner).toBe(GmRunner);
    expect(client.partyCoalesce).toBe(partyCoalesce);
  });

  it('partyCoalesce: same kind and player; low_hp per party; arrival hooks never', () => {
    expect(partyCoalesce(hook('idle'), hook('idle'))).toBe(true);
    expect(partyCoalesce(hook('boss_seen', 'p1'), hook('boss_seen', 'p1'))).toBe(true);
    expect(partyCoalesce(hook('boss_seen', 'p1'), hook('boss_seen', 'p2'))).toBe(false);
    expect(partyCoalesce(hook('low_hp', 'p1'), hook('low_hp', 'p2'))).toBe(true);
    expect(partyCoalesce(hook('milestone', 'p1'), hook('idle', 'p1'))).toBe(false);
    expect(partyCoalesce(hook('area_enter'), hook('area_enter'))).toBe(false);
    expect(partyCoalesce(hook('intro'), hook('intro'))).toBe(false);
  });

  it('coalesces queued hooks: the newer one takes the queued one\'s place, the running one is kept', async () => {
    const d = gated();
    const results: GmResult[] = [];
    const r = new GmRunner(d, { onResult: (x) => results.push(x), coalesce: partyCoalesce });
    r.request(hook('low_hp', 'p1', 1), ctx); // runs at once
    r.request(hook('low_hp', 'p2', 2), ctx);
    r.request(hook('milestone', 'p1', 3), ctx);
    r.request(hook('low_hp', 'p3', 4), ctx); // replaces p2's in place
    expect(r.pendingHooks().map((h) => `${h.hook}:${h.detail?.playerId}`)).toEqual(['low_hp:p1', 'low_hp:p3', 'milestone:p1']);
    for (let i = 0; i < 3; i++) {
      await flush();
      d.release();
      await flush();
    }
    await r.idle();
    expect(results.map((x) => (x.response.actions[0] as { text: string }).text)).toEqual(['low_hp:p1:1', 'low_hp:p3:4', 'milestone:p1:3']);
  });

  it('without coalesce (single player) every request is queued', () => {
    const d = gated();
    const r = new GmRunner(d, { onResult: () => undefined });
    for (let i = 0; i < 3; i++) r.request(hook('low_hp', undefined, i), ctx);
    expect(r.pending).toBe(3);
  });

  it('dropStale is checked at dequeue, before the director is asked; askedAt comes from the clock', async () => {
    const d = gated();
    let now = 1000;
    const results: GmResult[] = [];
    const r = new GmRunner(d, {
      onResult: (x) => results.push(x),
      now: () => now,
      dropStale: (h, at) => h.hook === 'low_hp' && now - at > 15_000,
    });
    r.request(hook('idle'), ctx); // running
    now = 2000;
    r.request(hook('low_hp', 'p1'), ctx);
    r.request(hook('milestone'), ctx);
    now = 20_000; // the low_hp moment has passed by the time the idle answer is in
    await flush();
    d.release();
    await flush();
    d.release();
    await r.idle();
    expect(d.asked.map((q) => q.hook)).toEqual(['idle', 'milestone']);
    expect(results.map((x) => [x.request.hook, x.askedAt])).toEqual([
      ['idle', 1000],
      ['milestone', 2000],
    ]);
  });
});
