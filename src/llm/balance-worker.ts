/**
 * Off-main-thread balance step for world generation in the browser. The bot simulations take
 * seconds to tens of seconds; run on the page they would freeze the loading screen.
 *
 * Client side:
 *   import { workerBalancer } from '../llm/balance-worker';
 *   const balancer = workerBalancer(() => new Worker(new URL('../llm/balance-worker.ts', import.meta.url), { type: 'module' }));
 *   await generateWorld({ provider, balancer, ... });
 *
 * Loaded as a worker, this module answers {id, world, difficulty, opts} messages with
 * {id, ok: true, outcome} or {id, ok: false, error}. `workerBalancer` falls back to the synchronous
 * `balanceWorld` when workers are unavailable or the worker fails to start.
 */
import type { WorldSpec } from '../schema/world';
import type { Difficulty } from '../schema/gm';
import { balanceWorld, type BalanceOptions, type BalanceOutcome, type Balancer } from './generate';

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

/** minimal Worker surface (DOM Worker or a test double) */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  addEventListener(type: 'error', fn: (e: unknown) => void): void;
}

/**
 * A Balancer that runs each balance step in a fresh worker (terminated afterwards, or on abort).
 * When `create` throws or the worker errors before answering, the step runs on this thread instead.
 */
export function workerBalancer(create: () => WorkerLike): Balancer {
  let nextId = 1;
  return (world, difficulty, opts, signal) =>
    new Promise<BalanceOutcome>((resolve, reject) => {
      let worker: WorkerLike;
      try {
        worker = create();
      } catch {
        resolve(balanceWorld(world, difficulty, opts));
        return;
      }
      const id = nextId++;
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        try {
          worker.terminate();
        } catch {
          /* already gone */
        }
        fn();
      };
      const onAbort = () => done(() => reject(new DOMException('aborted', 'AbortError')));
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.addEventListener('message', (e: { data: unknown }) => {
        const m = e.data as BalanceReplyMessage;
        if (!m || m.id !== id) return;
        if (m.ok) done(() => resolve(m.outcome));
        else done(() => reject(new Error(`balance worker: ${m.error}`)));
      });
      worker.addEventListener('error', () => done(() => resolve(balanceWorld(world, difficulty, opts))));
      const msg: BalanceRequestMessage = { id, world, difficulty, opts };
      worker.postMessage(msg);
    });
}

// worker entry: only when this module runs inside a dedicated worker
declare const WorkerGlobalScope: unknown;
const scope = globalThis as unknown as { postMessage?: (m: unknown) => void; addEventListener?: (t: string, f: (e: { data: unknown }) => void) => void };
if (typeof WorkerGlobalScope !== 'undefined' && typeof scope.postMessage === 'function' && typeof scope.addEventListener === 'function') {
  scope.addEventListener('message', (e) => {
    const m = e.data as BalanceRequestMessage;
    if (m && typeof m.id === 'number' && m.world) scope.postMessage!(handleBalanceMessage(m));
  });
}
