/**
 * The app shell's link to the audio engine (src/client/audio, DESIGN §5b) over the session
 * lifecycle:
 *
 *   startRun(world, area)  a run starts or resumes: the world's synth, the area's mood, unmuted per
 *                          settings (the AudioContext itself starts on the first tap/click/key —
 *                          browser autoplay rules, iOS)
 *   update(u)              after every engine change (GameSession.audioListener): sound effects,
 *                          danger moods, GM mood actions, and "boss" when a boss comes into view
 *   applySettings(s)       volume / mute / SoundCloud from the settings dialog
 *   mountPanel(host)       the world's music panel (mood, SoundCloud links / player) in `host`
 *   stopRun()              back to the start screen: silent until the next run
 *   dispose()
 *
 * The engine module is loaded lazily (its own chunk, fetched when the first run starts), so the
 * start screen stays small. Audio is optional: if the module fails to load or WebAudio is missing,
 * every call is a no-op and the game plays on silently.
 */
import type { WorldSpec } from '../schema/world';
import type { Settings } from './ui/viewmodel';
import type { AudioUpdate } from './audio-cues';
import type { MusicPanel, MusicPanelOptions } from './audio/music-panel';

/** the part of audio/index.ts GameAudio this bridge uses */
export interface BridgeAudio {
  onEvents(events: readonly unknown[], playerId?: string): void;
  onGmActions(actions: readonly unknown[]): void;
  setMood(mood: 'explore' | 'tense' | 'calm' | 'eerie' | 'boss' | 'upbeat'): void;
  mute(on?: boolean): void;
  applySettings(s: { volume?: number; muted?: boolean; soundcloud?: boolean }): void;
  setWorld(world: Pick<WorldSpec, 'audio' | 'meta' | 'areas'>, areaIndex?: number): void;
  dispose(): void;
}

/** the part of audio/music-panel.ts MusicPanel this bridge uses */
export type BridgeMusicPanel = Pick<MusicPanel, 'el' | 'update' | 'dispose'>;

export interface AudioModule {
  createAudio(world: Pick<WorldSpec, 'audio' | 'meta' | 'areas'>, settings?: { volume?: number; muted?: boolean; soundcloud?: boolean }): BridgeAudio;
  installUnlock(audio: BridgeAudio): () => void;
  /** the music panel (SoundCloud links / player, mood, mute and volume); optional */
  createMusicPanel?(opts: MusicPanelOptions): BridgeMusicPanel;
}

export type AudioLoader = () => Promise<AudioModule>;

const defaultLoader: AudioLoader = () => import('./audio/index') as unknown as Promise<AudioModule>;

export class AudioBridge {
  private audio: BridgeAudio | null = null;
  private loading: Promise<BridgeAudio | null> | null = null;
  private offUnlock: (() => void) | null = null;
  private mod: AudioModule | null = null;
  private panel: BridgeMusicPanel | null = null;
  /** the world the panel shows */
  private panelWorld: WorldSpec | null = null;
  private settings: Settings['audio'];
  private inRun = false;
  /** the current run's world (a late-loading module picks it up) */
  private world: WorldSpec | null = null;
  private area = 0;
  /** the boss mood was set for this sighting (cleared when no boss is in view) */
  private bossMood = false;
  private disposed = false;
  /** the module could not be loaded: stop trying */
  failed = false;

  constructor(settings: Settings['audio'], private readonly load: AudioLoader = defaultLoader) {
    this.settings = { ...settings };
  }

  /** the engine, once loaded (tests, debugging) */
  get engine(): BridgeAudio | null {
    return this.audio;
  }

  private ensure(): Promise<BridgeAudio | null> {
    if (this.audio) return Promise.resolve(this.audio);
    if (this.failed || this.disposed) return Promise.resolve(null);
    this.loading ??= this.load()
      .then((mod) => {
        if (this.disposed) return null;
        const world = this.world;
        if (!world) return null;
        const audio = mod.createAudio(world, { ...this.settings, muted: this.settings.muted || !this.inRun });
        audio.setWorld(world, this.area);
        this.offUnlock = mod.installUnlock(audio);
        this.mod = mod;
        this.audio = audio;
        return audio;
      })
      .catch((e) => {
        console.warn('[anyworld] audio unavailable, playing silently:', e);
        this.failed = true;
        return null;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private guard(fn: (a: BridgeAudio) => void): void {
    if (!this.audio) return;
    try {
      fn(this.audio);
    } catch (e) {
      console.warn('[anyworld] audio call failed:', e);
    }
  }

  /** a run starts or resumes in `world`, area `areaIndex` */
  async startRun(world: WorldSpec, areaIndex = 0): Promise<void> {
    this.world = world;
    this.area = areaIndex;
    this.inRun = true;
    this.bossMood = false;
    if (!this.audio) {
      await this.ensure();
      return;
    }
    this.guard((a) => {
      a.setWorld(world, areaIndex);
      a.mute(this.settings.muted);
    });
  }

  /** one engine change of the current run */
  update(u: AudioUpdate): void {
    if (!this.inRun) return;
    this.area = u.cue.area;
    this.guard((a) => {
      if (u.events.length) a.onEvents(u.events, u.playerId);
      if (u.gmActions?.length) a.onGmActions(u.gmActions);
      if (u.cue.situation === 'boss' && !this.bossMood) {
        this.bossMood = true;
        a.setMood('boss');
      } else if (u.cue.situation !== 'boss') this.bossMood = false;
    });
  }

  applySettings(s: Settings['audio']): void {
    this.settings = { ...s };
    this.guard((a) => a.applySettings({ volume: s.volume, soundcloud: !!s.soundcloud, muted: s.muted || !this.inRun }));
    this.panelCall((p) => p.update({ settings: { soundcloud: !!s.soundcloud } }));
  }

  private panelCall(fn: (p: BridgeMusicPanel) => void): void {
    if (!this.panel) return;
    try {
      fn(this.panel);
    } catch (e) {
      console.warn('[anyworld] music panel failed:', e);
    }
  }

  /**
   * Put the current run's music panel into `host` (the settings dialog's audio section). One panel
   * per run is kept and moved between hosts, so an open SoundCloud player survives a re-render.
   * Returns false when there is no run or the audio module (or its panel) is unavailable.
   */
  async mountPanel(host: HTMLElement): Promise<boolean> {
    if (!this.inRun || !this.world) return false;
    const audio = await this.ensure();
    const mod = this.mod;
    if (!audio || !mod?.createMusicPanel || !this.inRun || !this.world) return false;
    try {
      if (this.panel && this.panelWorld !== this.world) {
        this.panel.update({ audio: this.world.audio });
        this.panelWorld = this.world;
      }
      if (!this.panel) {
        // the loaded engine is the module's full GameAudio (BridgeAudio is the slice the bridge drives)
        this.panel = mod.createMusicPanel({ audio: this.world.audio, engine: audio as unknown as MusicPanelOptions['engine'], settings: { soundcloud: !!this.settings.soundcloud } });
        this.panelWorld = this.world;
      }
      if (this.panel.el.parentElement !== host) host.replaceChildren(this.panel.el);
      return true;
    } catch (e) {
      console.warn('[anyworld] music panel failed:', e);
      return false;
    }
  }

  private dropPanel(): void {
    this.panelCall((p) => {
      p.el.remove();
      p.dispose();
    });
    this.panel = null;
    this.panelWorld = null;
  }

  /** the run is over and the start screen shows: silence until the next run */
  stopRun(): void {
    this.inRun = false;
    this.bossMood = false;
    this.dropPanel();
    this.guard((a) => a.mute(true));
  }

  dispose(): void {
    this.disposed = true;
    this.dropPanel();
    this.offUnlock?.();
    this.offUnlock = null;
    this.guard((a) => a.dispose());
    this.audio = null;
  }
}
