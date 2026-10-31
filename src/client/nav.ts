/**
 * Browser history for the app's screens, so Back and Forward behave (PLAN: "Make the browser Back
 * button behave").
 *
 * Every screen has an address (boot.ts parses it): the start page is the bare path, a run is
 * `?world=<id>&seed=<n>`, a room is `?room=CODE`. Leaving the start page for a run, a room or a world
 * being made pushes an entry (marked `fromStart`), so Back returns to the start page; going home
 * from such an entry steps back instead of stacking another start page on top. Moves between other
 * screens (a new run from the end screen, the run that follows a world being made) replace the entry.
 *
 * Panels and dialogs (settings, help, rules, backpack) push an entry with the same address marked
 * `modal`, so Back closes them first. Closing one with its own button steps back over its entry; that
 * popstate is ours and is skipped (`consumePop`), and whatever is written meanwhile waits for it.
 *
 * Pure apart from the injected history, so it is unit-tested without a browser (tests/client/nav.test.ts).
 */

export interface NavState {
  aw: 1;
  /** this entry was pushed from the start page: Back (or going home) returns there */
  fromStart?: true;
  /** a panel or dialog is open on this entry: Back closes it */
  modal?: string;
  /** a world is being made (the loading screen); the run that follows replaces this entry */
  loading?: true;
}

export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  back(): void;
}

export function navState(raw: unknown): NavState | null {
  return raw && typeof raw === 'object' && (raw as NavState).aw === 1 ? (raw as NavState) : null;
}

export class Nav {
  /**
   * a step back of ours (home, or closing a panel) is on its way. history.back() is asynchronous:
   * anything written before its popstate would land on the entry being left and be stepped back
   * over, so later operations wait in `queue` and run, in order, once the popstate has come.
   */
  private pending: ReturnType<typeof setTimeout> | null = null;
  private queue: (() => void)[] = [];

  constructor(
    private readonly h: HistoryLike | null,
    private readonly here: () => string,
  ) {}

  state(): NavState | null {
    try {
      return navState(this.h?.state);
    } catch {
      return null;
    }
  }

  /** leaves the start page for `url` (a run, a room, the loading screen): Back comes back */
  push(url: string, extra: Pick<NavState, 'loading'> = {}): void {
    this.run(() => this.write('push', url, { aw: 1, fromStart: true, ...extra }));
  }

  /** shows `url` in place of the current entry (keeps whether it came from the start page) */
  replace(url: string, extra: Pick<NavState, 'loading'> = {}): void {
    this.run(() => {
      const from = this.state()?.fromStart;
      this.write('replace', url, { aw: 1, ...(from ? { fromStart: true as const } : {}), ...extra });
    });
  }

  /**
   * back to the start page at `url`: steps back when this entry was pushed from it (no second start
   * page in the history), otherwise replaces the entry.
   */
  home(url: string): void {
    this.run(() => {
      const s = this.state();
      if (s?.fromStart && !s.modal && this.stepBack()) return;
      this.write('replace', url, { aw: 1 });
    });
  }

  /** a panel or dialog opened: Back should close it */
  openModal(name: string): void {
    this.run(() => {
      const s = this.state();
      if (s?.modal === name) return;
      this.write('push', this.here(), { ...(s ?? { aw: 1 }), modal: name, aw: 1 }, true);
    });
  }

  /** a panel or dialog closed by its own controls: step back over its entry */
  closeModal(name: string): void {
    this.run(() => {
      if (this.state()?.modal === name) this.stepBack();
    });
  }

  /** the entry popped to still says a panel is open but none is: forget that */
  clearModal(): void {
    this.run(() => {
      const s = this.state();
      if (!s?.modal) return;
      const { modal: _m, ...rest } = s;
      this.write('replace', this.here(), rest, true);
    });
  }

  /** call first in the popstate handler: true when this pop is one we caused (home, closeModal) */
  consumePop(): boolean {
    if (!this.pending) return false;
    this.flush();
    return true;
  }

  private run(op: () => void): void {
    if (this.pending) this.queue.push(op);
    else op();
  }

  private stepBack(): boolean {
    if (!this.h) return false;
    try {
      this.h.back();
    } catch {
      return false;
    }
    // (the popstate normally comes within a frame; never wait on it for long)
    this.pending = setTimeout(() => this.flush(), 400);
    return true;
  }

  private flush(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    // (an operation may step back again: the rest then waits for that popstate)
    while (this.queue.length && !this.pending) this.queue.shift()!();
  }

  private write(kind: 'push' | 'replace', url: string, state: NavState, sameUrl = false): void {
    if (!this.h) return;
    try {
      const here = this.here();
      const next = new URL(url, here).href;
      // (a push to the address already shown is only for modals and the loading screen)
      if (kind === 'replace' && next === here && !sameUrl && JSON.stringify(this.state()) === JSON.stringify(state)) return;
      if (kind === 'push') this.h.pushState(state, '', next);
      else this.h.replaceState(state, '', next);
    } catch {
      /* history can be unavailable (sandboxed frames); the screens work without it */
    }
  }
}
