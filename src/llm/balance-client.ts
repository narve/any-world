/**
 * The page side of the off-main-thread balance step (balance-worker.ts is the worker): a Balancer
 * that posts each step to a fresh worker. Without workers it runs the step on the page, loading the
 * bots only then (generate.ts balanceHere), so they never weigh on the start bundle.
 */
import type { Balancer, BalanceOutcome } from './generate';
import { balanceHere } from './generate';
import type { BalanceReplyMessage, BalanceRequestMessage } from './balance-worker';

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
        resolve(balanceHere(world, difficulty, opts));
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
      worker.addEventListener('error', () => done(() => resolve(balanceHere(world, difficulty, opts))));
      const msg: BalanceRequestMessage = { id, world, difficulty, opts };
      worker.postMessage(msg);
    });
}

