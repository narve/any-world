/**
 * Audio may only start after a user gesture (iOS Safari, and Chrome's autoplay policy). This hook
 * listens for the first tap, click or key press anywhere and calls the audio module's unlock
 * inside that gesture. The audio module is optional and loaded lazily: `load` resolves to whatever
 * it exports, and any of these shapes is accepted:
 *
 *   export function unlock(): void | Promise<void>
 *   export const audio = { unlock() {…} }
 *   export default { unlock() {…} }
 *   export function unlockAudio(): void
 *
 * The module is fetched straight away (not on the tap), so the call happens synchronously within
 * the gesture, which iOS requires. Gestures that arrive before the module has loaded are counted,
 * and the next one unlocks. Listeners are removed once unlock has been called.
 */

type Unlock = () => unknown;

/** finds an unlock function in an audio module's exports (see the module comment) */
export function findUnlock(mod: unknown): Unlock | null {
  if (!mod || typeof mod !== 'object') return null;
  const m = mod as Record<string, unknown>;
  const pick = (o: unknown, name: string): Unlock | null => {
    if (!o || (typeof o !== 'object' && typeof o !== 'function')) return null;
    const f = (o as Record<string, unknown>)[name];
    return typeof f === 'function' ? (f.bind(o) as Unlock) : null;
  };
  return pick(m, 'unlock') ?? pick(m.audio, 'unlock') ?? pick(m.default, 'unlock') ?? pick(m, 'unlockAudio') ?? null;
}

export interface AudioUnlockOptions {
  /** loads the audio module (null / rejection: there is no audio) */
  load: () => Promise<unknown> | null;
  /** event source (default window) */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** called after unlock ran (tests, logging) */
  onUnlocked?: () => void;
}

export interface AudioUnlockHandle {
  /** true once unlock has been called */
  readonly unlocked: boolean;
  detach(): void;
}

const EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'] as const;

export function installAudioUnlock(opts: AudioUnlockOptions): AudioUnlockHandle {
  const target = opts.target ?? window;
  let unlockFn: Unlock | null = null;
  let done = false;
  let pending = false;
  let gone = false;

  const detach = () => {
    if (gone) return;
    gone = true;
    for (const ev of EVENTS) target.removeEventListener(ev, onGesture, true);
  };

  const run = () => {
    if (done || !unlockFn) return;
    done = true;
    try {
      const r = unlockFn();
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch((e) => console.warn('[anyworld] audio unlock failed:', e));
    } catch (e) {
      console.warn('[anyworld] audio unlock failed:', e);
    }
    detach();
    opts.onUnlocked?.();
  };

  function onGesture(): void {
    if (unlockFn) run();
    else pending = true;
  }

  for (const ev of EVENTS) target.addEventListener(ev, onGesture, { capture: true, passive: true } as AddEventListenerOptions);

  const p = opts.load();
  if (!p) detach();
  else
    p.then(
      (mod) => {
        unlockFn = findUnlock(mod);
        if (!unlockFn) return detach();
        // a gesture already happened: unlock on the next one (this callback is not a gesture)
        if (pending) pending = false;
      },
      () => detach(),
    );

  return {
    get unlocked() {
      return done;
    },
    detach,
  };
}
