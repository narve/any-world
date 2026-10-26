/**
 * AnyWorld audio (DESIGN §5b) — optional; the game is fully playable with audio off or missing.
 *
 * ```ts
 * import { createAudio, installUnlock } from './audio';     // or lazily: await import('./audio')
 *
 * const audio = createAudio(world, settings.audio);          // silent until unlocked
 * installUnlock(audio);                                      // first tap/click/key unlocks it
 * audio.onEvents(step.events, leadPlayer(state).actorId);         // after every engine step: sfx + mood
 * audio.onGmActions(gmResponse.actions);                     // GM 'mood' actions
 * audio.setMood('boss');                                     // or set a mood directly
 * audio.setVolume(0.5); audio.mute(true); audio.mute(false);
 * audio.setWorld(nextWorld);                                 // new run, same context
 * audio.dispose();
 * ```
 *
 * - **Generative ambience** (./ambience.ts) from `world.audio.synth`, bent by the mood
 *   (explore/tense/calm/eerie/boss/upbeat). Moods come from the area (`AreaPlan.music`), the GM's
 *   `mood` actions, danger (low health / fighting) and the end of the run — see ./mood.ts. Mood
 *   changes crossfade.
 * - **Sound effects** (./sfx.ts) for steps, hits, misses, pick-ups, item use, level-ups, kills
 *   and death, in the world's timbre and key.
 * - **Music panel** (./music-panel.ts) with SoundCloud links and an opt-in widget.
 *
 * Browser rules: the AudioContext is created inside `unlock()`, which must run in a user gesture
 * (autoplay policies, iOS). Until then every call is a cheap no-op apart from remembering state.
 * Hidden tabs suspend the context; muting suspends it too, so a muted game costs no CPU.
 */
import type { GameEvent } from '../../engine/types';
import type { WorldSpec } from '../../schema/world';
import { Ambience } from './ambience';
import { MoodDirector, moodFromGmActions } from './mood';
import { playSfx, sfxForEvents, sfxPalette, type SfxName, type SfxPalette } from './sfx';
import { isMood, type MusicMood } from './theory';
import { VoiceBudget } from './voices';

export { MOODS, type MusicMood } from './theory';
export { sfxForEvents, SFX_NAMES, type SfxName } from './sfx';
export { MoodDirector, moodFromGmActions } from './mood';
export { createMusicPanel, musicPanelModel, soundcloudSearchUrl, isSoundcloudUrl, type MusicPanel, type MusicPanelOptions } from './music-panel';

/**
 * Audio settings. `volume`/`muted` are the persisted `Settings.audio` fields; the others are
 * optional (defaults shown) so older saved settings keep working.
 */
export interface AudioSettings {
  /** 0..1 master volume */
  volume: number;
  muted: boolean;
  /** generated ambience music (default true) */
  music?: boolean;
  /** sound effects (default true) */
  sfx?: boolean;
  /** embedded SoundCloud widget in the music panel (default false) */
  soundcloud?: boolean;
}

/** the part of a world the audio needs */
export type AudioWorld = Pick<WorldSpec, 'audio'> & {
  meta?: Partial<Pick<WorldSpec['meta'], 'title'>>;
  areas?: readonly { music?: string }[];
};

export interface GameAudio {
  /**
   * Create/resume the AudioContext. Call from a user gesture (click, tap, key). Resolves true once
   * audio is unlocked, even if muted (false: unsupported, blocked or disposed — the game goes on
   * silently).
   */
  unlock(): Promise<boolean>;
  /** one batch of engine events → sound effects and mood changes */
  onEvents(events: readonly GameEvent[], playerId?: string): void;
  /** GM actions (only `mood` actions matter here) */
  onGmActions(actions: readonly unknown[]): void;
  /** set the music mood now (as a GM override until the next area) */
  setMood(mood: MusicMood): void;
  /** 0..1 */
  setVolume(volume: number): void;
  /** mute(true) / mute(false); mute() mutes */
  mute(on?: boolean): void;
  /** turn the generated music on/off (sound effects unaffected) */
  setAmbience(on: boolean): void;
  /** turn sound effects on/off */
  setSfx(on: boolean): void;
  /** fade the generated music down while external music (SoundCloud) plays */
  duck(on: boolean): void;
  /** apply changed settings in one go */
  applySettings(settings: Partial<AudioSettings>): void;
  /** switch to another world (new run): new synth, palette and area moods */
  setWorld(world: AudioWorld, areaIndex?: number): void;
  /** play one sound effect directly */
  play(name: SfxName): void;
  /** called after mood / mute / volume / ambience / sfx changes; returns an unsubscribe function */
  subscribe(fn: () => void): () => void;
  /** stop everything and close the context */
  dispose(): void;

  readonly unlocked: boolean;
  readonly muted: boolean;
  readonly volume: number;
  readonly ambience: boolean;
  readonly sfx: boolean;
  readonly mood: MusicMood;
  /** false when this browser has no WebAudio */
  readonly supported: boolean;
}

/** injection points for tests and unusual hosts */
export interface AudioDeps {
  /** default: `new (window.AudioContext ?? window.webkitAudioContext)()` */
  createContext?: () => AudioContext;
  /** visibility source (default: `document`) */
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'hidden'>;
  /** scheduler timer (default: globalThis.setInterval) */
  timers?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void };
  /** random source for the melody (default: seeded from the world title) */
  random?: () => number;
  /** scheduler period in ms (default 100) */
  tickMs?: number;
}

/** minimum time between two footstep sounds, seconds */
const STEP_GAP = 0.09;

function defaultContextFactory(): (() => AudioContext) | null {
  const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  return Ctor ? () => new Ctor({ latencyHint: 'playback' }) : null;
}

/** perceptual volume curve */
function gainFor(volume: number): number {
  return volume * volume;
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

export function createAudio(world: AudioWorld, settings: Partial<AudioSettings> = {}, deps: AudioDeps = {}): GameAudio {
  const factory = deps.createContext ?? defaultContextFactory();
  const doc = deps.doc ?? (typeof document === 'undefined' ? undefined : document);
  const timers = deps.timers ?? {
    setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
    clearInterval: (h: unknown) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  };
  const tickMs = deps.tickMs ?? 100;

  let current: AudioWorld = world;
  let volume = clamp01(settings.volume ?? 0.6);
  let muted = !!settings.muted;
  let ambienceOn = settings.music !== false;
  let sfxOn = settings.sfx !== false;
  let ducked = false;
  let disposed = false;
  const director = new MoodDirector((world.areas ?? []).map((a) => a.music));
  let palette: SfxPalette = sfxPalette(world.audio?.synth);

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let musicBus: GainNode | null = null;
  let sfxBus: GainNode | null = null;
  let ambience: Ambience | null = null;
  const sfxBudget = new VoiceBudget(10);
  let timer: unknown = null;
  let lastStep = -1;
  let stepVariant = 0;
  let unlocking: Promise<boolean> | null = null;
  /** the context ran at least once (a user gesture unlocked it) */
  let everRan = false;

  const listeners = new Set<() => void>();
  let lastMood: MusicMood = director.current;
  let pendingMood: MusicMood = director.current;
  function notify(): void {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* a listener's problem, not ours */
      }
    }
  }

  const hidden = () => !!doc?.hidden;
  const running = () => !!ctx && ctx.state === 'running';

  function build(c: AudioContext): void {
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    comp.connect(c.destination);
    master = c.createGain();
    master.gain.value = muted ? 0 : gainFor(volume);
    master.connect(comp);

    musicBus = c.createGain();
    musicBus.gain.value = ambienceLevel();
    musicBus.connect(master);
    // a cheap feedback echo instead of a convolution reverb (mobile CPU)
    const delay = c.createDelay(1);
    delay.delayTime.value = 0.37;
    const fb = c.createGain();
    fb.gain.value = 0.32;
    const wet = c.createGain();
    wet.gain.value = 0.3;
    musicBus.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(master);

    sfxBus = c.createGain();
    sfxBus.gain.value = 0.9;
    sfxBus.connect(master);

    ambience = new Ambience(c, musicBus, current.audio?.synth, {
      random: deps.random,
      seedText: current.meta?.title ?? JSON.stringify(current.audio?.synth ?? {}),
    });
  }

  function ambienceLevel(): number {
    return ambienceOn ? (ducked ? 0.0001 : 1) : 0.0001;
  }

  function ramp(param: AudioParam | undefined, value: number, tc = 0.15): void {
    if (!param || !ctx) return;
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, tc);
  }

  function startClock(): void {
    if (timer !== null || disposed) return;
    timer = timers.setInterval(() => ambience?.tick(), tickMs);
  }

  function stopClock(): void {
    if (timer === null) return;
    timers.clearInterval(timer);
    timer = null;
  }

  /**
   * Bring playback in line with muted / hidden / ambience state. Calls are serialised: resume() and
   * suspend() change `ctx.state` only when they settle, so two overlapping passes could each act on
   * a stale state (unmute then mute before resume settled left the context running while muted).
   * A call made while a pass is in flight marks it dirty; the pass then runs again with the latest
   * flags, and every caller's promise resolves only after that final pass.
   */
  let syncing: Promise<void> | null = null;
  let syncDirty = false;
  function sync(): Promise<void> {
    if (syncing) {
      syncDirty = true;
      return syncing;
    }
    syncing = (async () => {
      try {
        do {
          syncDirty = false;
          await syncOnce();
        } while (syncDirty && !disposed);
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  async function syncOnce(): Promise<void> {
    if (!ctx || disposed) return;
    const shouldRun = !muted && !hidden();
    if (shouldRun) {
      if (ctx.state !== 'running') {
        try {
          await ctx.resume();
        } catch {
          /* blocked: stays silent */
        }
      }
      // flags changed during resume(): the next pass (syncDirty) suspends again
      if (disposed || muted || hidden()) return;
      ambience?.resync();
      if (ambienceOn && !ducked && ambience && !ambience.playing) ambience.start(director.current);
      if (ambienceOn && ambience?.playing) {
        startClock();
        ambience.tick();
      }
    } else {
      stopClock();
      if (ctx.state === 'running') {
        try {
          await ctx.suspend();
        } catch {
          /* ignore */
        }
      }
    }
  }

  function onVisibility(): void {
    void sync();
  }
  doc?.addEventListener('visibilitychange', onVisibility);

  function applyMood(): void {
    const m = director.current;
    pendingMood = m;
    if (ambience && ambience.mood !== m) ambience.setMood(m);
    if (m !== lastMood) {
      lastMood = m;
      notify();
    }
  }
  function playOne(name: SfxName, at?: number): void {
    if (!ctx || !sfxBus || !sfxOn || muted || !running()) return;
    const t = at ?? ctx.currentTime + 0.01;
    if (name === 'step') {
      if (t - lastStep < STEP_GAP) return;
      lastStep = t;
      stepVariant++;
    }
    playSfx(ctx, sfxBus, sfxBudget, name, palette, t, stepVariant);
  }

  const api: GameAudio = {
    unlock(): Promise<boolean> {
      if (disposed) return Promise.resolve(false);
      if (unlocking) return unlocking;
      unlocking = (async () => {
        try {
          if (!ctx) {
            if (!factory) return false;
            ctx = factory();
            build(ctx);
            ambience!.setMood(pendingMood);
            // iOS: playing a (silent) buffer inside the gesture unlocks output
            const b = ctx.createBuffer(1, 1, ctx.sampleRate);
            const s = ctx.createBufferSource();
            s.buffer = b;
            s.connect(ctx.destination);
            s.start(0);
          }
          // resume inside the gesture even when muted, so a later unmute may start sound
          if (ctx.state !== 'running') await ctx.resume();
          if (ctx.state === 'running') everRan = true;
          await sync();
          return everRan;
        } catch {
          return false;
        } finally {
          unlocking = null;
        }
      })();
      return unlocking;
    },

    onEvents(events, playerId) {
      if (disposed || !events.length) return;
      const before = director.current;
      const after = director.onEvents(events, playerId);
      if (after !== before) applyMood();
      if (!running()) return;
      const names = sfxForEvents(events, playerId);
      const t0 = ctx!.currentTime + 0.01;
      names.forEach((n, i) => playOne(n, t0 + i * 0.03));
    },

    onGmActions(actions) {
      const m = moodFromGmActions(actions);
      if (m) api.setMood(m);
    },

    setMood(mood) {
      if (disposed || !isMood(mood)) return;
      director.setGm(mood);
      applyMood();
    },

    setVolume(v) {
      volume = clamp01(v);
      if (!muted) ramp(master?.gain, gainFor(volume), 0.05);
      notify();
    },

    mute(on = true) {
      muted = !!on;
      ramp(master?.gain, muted ? 0 : gainFor(volume), 0.05);
      void sync();
      notify();
    },

    setAmbience(on) {
      ambienceOn = !!on;
      ramp(musicBus?.gain, ambienceLevel(), 0.4);
      if (!ambienceOn) {
        ambience?.stop(0.8);
        stopClock();
      } else void sync();
      notify();
    },

    setSfx(on) {
      sfxOn = !!on;
      notify();
    },

    duck(on) {
      ducked = !!on;
      ramp(musicBus?.gain, ambienceLevel(), 0.6);
      if (ducked) {
        ambience?.stop(2);
        // let the fade finish, then idle the clock
        if (ctx) setTimeoutSafe(() => ducked && stopClock(), 2500);
      } else void sync();
    },

    applySettings(s) {
      if (s.volume !== undefined) api.setVolume(s.volume);
      if (s.muted !== undefined && !!s.muted !== muted) api.mute(s.muted);
      if (s.music !== undefined && (s.music !== false) !== ambienceOn) api.setAmbience(s.music !== false);
      if (s.sfx !== undefined) api.setSfx(s.sfx !== false);
    },

    setWorld(w, areaIndex = 0) {
      current = w;
      palette = sfxPalette(w.audio?.synth);
      director.setAreas((w.areas ?? []).map((a) => a.music), areaIndex);
      if (ambience) ambience.setSynth(w.audio?.synth);
      applyMood();
    },

    play(name) {
      playOne(name);
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      stopClock();
      doc?.removeEventListener('visibilitychange', onVisibility);
      ambience?.dispose();
      ambience = null;
      const c = ctx;
      ctx = null;
      if (c) {
        try {
          void c.close().catch(() => undefined);
        } catch {
          /* ignore */
        }
      }
    },

    get unlocked() {
      return everRan && !!ctx;
    },
    get muted() {
      return muted;
    },
    get volume() {
      return volume;
    },
    get ambience() {
      return ambienceOn;
    },
    get sfx() {
      return sfxOn;
    },
    get mood() {
      return director.current;
    },
    get supported() {
      return !!factory;
    },
  };
  return api;
}

function setTimeoutSafe(fn: () => void, ms: number): void {
  try {
    globalThis.setTimeout(fn, ms);
  } catch {
    /* no timers */
  }
}

/**
 * Unlock audio on the first user gesture anywhere on `target` (default: window). The listeners
 * remove themselves once audio runs. Returns a function that removes them early.
 */
export function installUnlock(audio: Pick<GameAudio, 'unlock'>, target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): () => void {
  const t = target ?? (typeof window === 'undefined' ? undefined : window);
  if (!t) return () => undefined;
  const events = ['pointerdown', 'touchend', 'keydown', 'click'];
  const off = () => {
    for (const e of events) t.removeEventListener(e, handler, true);
  };
  const handler = () => {
    void audio.unlock().then((ok) => {
      if (ok) off();
    });
  };
  for (const e of events) t.addEventListener(e, handler, true);
  return off;
}
