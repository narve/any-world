/**
 * Tiny time-based tween scheduler used for event animations. Deterministic given the times passed to
 * `tick`, so it is unit-testable without a browser. "Blocking" tweens are the ones `sync()` waits for;
 * cosmetic ones (floating numbers, fades) keep playing after the turn resolves.
 */
export type Ease = (k: number) => number;

export const ease = {
  linear: (k: number) => k,
  outCubic: (k: number) => 1 - Math.pow(1 - k, 3),
  inOutQuad: (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),
  outBack: (k: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
  },
  /** 0 → 1 → 0 */
  pingPong: (k: number) => Math.sin(k * Math.PI),
};

export interface TweenSpec {
  /** ms after now */
  delay?: number;
  /** ms */
  duration: number;
  update: (k: number) => void;
  done?: () => void;
  ease?: Ease;
  /** whether sync() waits for this tween (default true) */
  blocking?: boolean;
  /** called once when the tween starts (after its delay) */
  start?: () => void;
}

interface Tween extends Required<Pick<TweenSpec, 'duration' | 'update'>> {
  at: number;
  ease: Ease;
  blocking: boolean;
  done?: () => void;
  start?: () => void;
  started: boolean;
}

export class Animator {
  private tweens: Tween[] = [];
  private waiters: (() => void)[] = [];
  now = 0;

  add(spec: TweenSpec): void {
    this.tweens.push({
      at: this.now + Math.max(0, spec.delay ?? 0),
      duration: Math.max(1, spec.duration),
      update: spec.update,
      done: spec.done,
      start: spec.start,
      started: false,
      ease: spec.ease ?? ease.linear,
      blocking: spec.blocking ?? true,
    });
  }

  /** Advance to time `now` (ms). */
  tick(now: number): void {
    this.now = now;
    if (this.tweens.length === 0) return this.flushWaiters();
    const remaining: Tween[] = [];
    const list = this.tweens;
    this.tweens = [];
    for (const t of list) {
      if (now < t.at) {
        remaining.push(t);
        continue;
      }
      if (!t.started) {
        t.started = true;
        t.start?.();
      }
      const k = Math.min(1, (now - t.at) / t.duration);
      t.update(t.ease(k));
      if (k >= 1) t.done?.();
      else remaining.push(t);
    }
    // tweens added during callbacks land in this.tweens
    this.tweens = remaining.concat(this.tweens);
    this.flushWaiters();
  }

  /** Jump every tween (blocking or not) to its end state. */
  finishAll(): void {
    let guard = 0;
    while (this.tweens.length && guard++ < 10) {
      const list = this.tweens;
      this.tweens = [];
      for (const t of list) {
        if (!t.started) {
          t.started = true;
          t.start?.();
        }
        t.update(t.ease(1));
        t.done?.();
      }
    }
    this.tweens = [];
    this.flushWaiters();
  }

  /** Jump only the blocking tweens to their end; cosmetic ones keep playing. */
  finishBlocking(): void {
    let guard = 0;
    while (this.busy && guard++ < 10) {
      const list = this.tweens;
      this.tweens = [];
      const keep: Tween[] = [];
      for (const t of list) {
        if (!t.blocking) {
          keep.push(t);
          continue;
        }
        if (!t.started) {
          t.started = true;
          t.start?.();
        }
        t.update(t.ease(1));
        t.done?.();
      }
      this.tweens = keep.concat(this.tweens);
    }
    this.flushWaiters();
  }

  get busy(): boolean {
    return this.tweens.some((t) => t.blocking);
  }

  get size(): number {
    return this.tweens.length;
  }

  /** Resolves once no blocking tweens remain. */
  whenIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }

  private flushWaiters(): void {
    if (this.waiters.length && !this.busy) {
      const w = this.waiters;
      this.waiters = [];
      for (const f of w) f();
    }
  }
}
