/**
 * Toast stack model (DOM-free, testable). Identical toasts merge into one entry with a count and a
 * restarted timer instead of piling up, and at most `max` entries are visible: the oldest goes
 * first. See issues/M1-toast-pileup.md.
 */

export type ToastTone = 'info' | 'warn';

export interface ToastEntry {
  id: number;
  text: string;
  tone: ToastTone;
  /** how many times this toast was raised while visible */
  count: number;
  /** bumped on every change, so a stale timer can tell it was superseded */
  gen: number;
}

export interface ToastTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ToastStackOptions {
  /** visible entries at most (default 3) */
  max?: number;
  /** how long an entry stays before fading (default 2600 ms) */
  showMs?: number;
  /** fade-out duration (default 500 ms) */
  fadeMs?: number;
  timers?: ToastTimers;
  /** called after every change with the visible entries (oldest first) and the leaving ids */
  onChange?: (entries: readonly ToastEntry[], leaving: ReadonlySet<number>) => void;
}

const defaultTimers: ToastTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class ToastStack {
  private list: ToastEntry[] = [];
  private leaving = new Set<number>();
  private handles = new Map<number, unknown[]>();
  private seq = 0;
  private readonly max: number;
  private readonly showMs: number;
  private readonly fadeMs: number;
  private readonly timers: ToastTimers;

  constructor(private opts: ToastStackOptions = {}) {
    this.max = Math.max(1, opts.max ?? 3);
    this.showMs = opts.showMs ?? 2600;
    this.fadeMs = opts.fadeMs ?? 500;
    this.timers = opts.timers ?? defaultTimers;
  }

  get entries(): readonly ToastEntry[] {
    return this.list;
  }

  isLeaving(id: number): boolean {
    return this.leaving.has(id);
  }

  push(text: string, tone: ToastTone = 'info'): ToastEntry {
    const same = this.list.find((e) => e.text === text && e.tone === tone);
    let entry: ToastEntry;
    if (same) {
      // merge: count it, bring it to the front of the stack, and start its timer again
      this.list = this.list.filter((e) => e !== same);
      entry = { ...same, count: same.count + 1, gen: same.gen + 1 };
      this.leaving.delete(same.id);
    } else {
      entry = { id: ++this.seq, text, tone, count: 1, gen: 0 };
    }
    this.list.push(entry);
    while (this.list.length > this.max) this.drop(this.list[0].id);
    this.schedule(entry);
    this.emit();
    return entry;
  }

  clear(): void {
    for (const e of [...this.list]) this.drop(e.id);
    this.emit();
  }

  private schedule(e: ToastEntry): void {
    this.cancel(e.id);
    const fade = this.timers.set(() => {
      this.leaving.add(e.id);
      this.emit();
    }, this.showMs);
    const gone = this.timers.set(() => {
      this.drop(e.id);
      this.emit();
    }, this.showMs + this.fadeMs);
    this.handles.set(e.id, [fade, gone]);
  }

  private cancel(id: number): void {
    for (const h of this.handles.get(id) ?? []) this.timers.clear(h);
    this.handles.delete(id);
  }

  private drop(id: number): void {
    this.cancel(id);
    this.leaving.delete(id);
    this.list = this.list.filter((e) => e.id !== id);
  }

  private emit(): void {
    this.opts.onChange?.(this.list, this.leaving);
  }
}

/** the text a toast shows: "text ×3" once it was raised more than once */
export function toastLabel(e: Pick<ToastEntry, 'text' | 'count'>): string {
  return e.count > 1 ? `${e.text} ×${e.count}` : e.text;
}
