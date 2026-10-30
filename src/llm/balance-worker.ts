/**
 * Off-main-thread balance step for world generation in the browser. The bot simulations take
 * seconds to tens of seconds; run on the page they would freeze the loading screen.
 *
 * Client side:
 *   import { workerBalancer } from '../llm/balance-client';
 *   const balancer = workerBalancer(() => new Worker(new URL('../llm/balance-worker.ts', import.meta.url), { type: 'module' }));
 *   await generateWorld({ provider, balancer, ... });
 *
 * Loaded as a worker, this module answers {id, world, difficulty, opts} messages with
 * {id, ok: true, outcome} or {id, ok: false, error}. `workerBalancer` (balance-client.ts, re-exported
 * here) falls back to `balanceWorld` on the page when workers are unavailable or the worker fails to
 * start. The page imports balance-client.ts directly, so the bots stay out of the start bundle.
 */
import type { WorldSpec } from '../schema/world';
import type { Difficulty } from '../schema/gm';
import type { BalanceOptions, BalanceOutcome } from './generate';
import { balanceWorld } from './balance-run';

export interface BalanceRequestMessage {
  id: number;
  world: WorldSpec;
  difficulty: Difficulty;
  opts: BalanceOptions;
}

export type BalanceReplyMessage = { id: number; ok: true; outcome: BalanceOutcome } | { id: number; ok: false; error: string };

/** the worker's message handler (exported for tests) */
export function handleBalanceMessage(msg: BalanceRequestMessage): BalanceReplyMessage {
  try {
    return { id: msg.id, ok: true, outcome: balanceWorld(msg.world, msg.difficulty, msg.opts ?? {}) };
  } catch (e) {
    return { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export { workerBalancer, type WorkerLike } from './balance-client';

// worker entry: only when this module runs inside a dedicated worker
declare const WorkerGlobalScope: unknown;
const scope = globalThis as unknown as { postMessage?: (m: unknown) => void; addEventListener?: (t: string, f: (e: { data: unknown }) => void) => void };
if (typeof WorkerGlobalScope !== 'undefined' && typeof scope.postMessage === 'function' && typeof scope.addEventListener === 'function') {
  scope.addEventListener('message', (e) => {
    const m = e.data as BalanceRequestMessage;
    if (m && typeof m.id === 'number' && m.world) scope.postMessage!(handleBalanceMessage(m));
  });
}
