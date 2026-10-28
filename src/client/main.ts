/**
 * App shell: the start screen (demo worlds, saved run, settings), one GameController per run, and
 * the end screen. URL shortcuts: `?world=<bundled id>&seed=<n>` starts that world straight away
 * (demo links, e2e tests) or resumes its autosaved run; `?continue=1` resumes the autosaved run.
 * The address bar always names the run on screen (see boot.ts), so a reload continues it.
 *
 * Rooms (MP3 design §1.2, §2): with a game server (roomsEndpoint), the start page lists the open
 * rooms ("Play together"), every world card can make a room ("Play with friends"), and `?room=CODE`
 * joins one. All of that lives in room/flow.ts (RoomFlow), a lazy chunk fetched at boot only when
 * the build has a server; the App hands it its screens, renderer and controller (RoomAppHost). A room
 * never reads, clears or writes the single-player save; the address bar keeps `?room=CODE`.
 */
import { createUi, type GameUi, type Settings, type StartView, type UiCallbacks, type UiViewModel, type InspirationPrompt, type DemoWorldView, type SettingsView, type StartOptions, type Difficulty } from './ui/index';
import { DEFAULT_PALETTE } from './ui/index';
import { defaultVocabulary, localizedPreset } from './ui/format';
import type { Renderer } from './render/index';
import { loadRenderer, preloadRenderer } from './render/lazy';
import { listPresets } from '../llm/presets';
import { fetchServerInfo } from '../llm/transport';
import type { LLMProvider } from '../llm/types';
import { workerBalancer } from '../llm/balance-worker';
import { loadBundledRecordings, recordedWorldKeys } from '../llm/recordings-bundle';
import { findStoredWorld, forgetWorld, generatedWorlds, hasWorld, loadBundledWorld, loadWorld, recordingsKey, rememberWorld, worldIndex, worldTitle, type WorldEntry } from './worlds';
import { providerFromSettings, providerLabel, runAi, WorldGeneration } from './ai';
import { activeProvider, clearRun, loadRun, loadSettings, onboardingSeen, reconcileApiKeys, recentSource, saveSettings } from './storage';
import { demoGenerator, generationHint, OFFLINE_PRESET, pickDemoWorld, providerProblem, problemText, providerStatus, type ServerState } from './modes';
import { exportWorldFile, parseWorldFile } from './world-file';
import { AudioBridge } from './audio-bridge';
import type { RecentWorldView, WorldFileInput } from './ui/viewmodel';
import { tx } from './i18n/index';
import { availableLanguages, getLanguage, setLanguage, t } from './i18n/index';
import { GameSession } from './session';
import { demoWorldsFor, localizedInspiration, promptLibrary } from './prompts';
import { GameController } from './game-controller';
import { bootRoute, runUrl } from './boot';
import { pageBuild, roomsEndpoint, type RoomsEndpoint } from './room/config';
import type { RoomFlow, RoomHandle } from './room/flow';

declare global {
  interface Window {
    /** automation handle for e2e tests and debugging */
    __anyworld?: App;
  }
}

/** the room list on the start page refreshes this often while it is visible (ms) */
const ROOM_LIST_MS = 15_000;

/** the server's origin when the page is hosted elsewhere (build: ANYWORLD_SERVER_URL); '' = same origin */
const SERVER_URL: string = typeof __ANYWORLD_SERVER__ !== 'undefined' ? __ANYWORLD_SERVER__ : '';
const BUILD_TRANSPORT: 'direct' | 'backend' = typeof __ANYWORLD_DEFAULT_TRANSPORT__ !== 'undefined' ? __ANYWORLD_DEFAULT_TRANSPORT__ : 'backend';
/** a static build pointed at a server (SERVER_URL) uses it like the backend build does */
const DEFAULT_TRANSPORT: 'direct' | 'backend' = SERVER_URL ? 'backend' : BUILD_TRANSPORT;
/** a static (browser-only) build with no server has no backend to talk to */
const TRANSPORTS: ('direct' | 'backend')[] = DEFAULT_TRANSPORT === 'direct' ? ['direct'] : ['direct', 'backend'];

function randomSeed(): number {
  // UI-side randomness is fine here; the engine only ever sees the resulting seed
  const a = new Uint32Array(1);
  globalThis.crypto?.getRandomValues?.(a);
  return (a[0] || Math.floor(Math.random() * 0x7fffffff)) >>> 0 || 1;
}

export class App {
  ui: GameUi;
  /** created with the first run (WebGL is not needed for the start screen) */
  renderer: Renderer | null = null;
  controller: GameController | null = null;
  private settings: Settings;
  private settingsOpen = false;
  screen: 'start' | 'loading' | 'lobby' | 'game' = 'start';
  /** what the backend said about the presets it can serve */
  private server: ServerState = { kind: 'unknown' };
  /** advice shown under a failed world generation (modes.ts generationHint) */
  private genHint: string | null = null;
  /** the audio engine over the run lifecycle (lazy, optional) */
  readonly audio: AudioBridge;
  private generation: WorldGeneration | null = null;
  private lastStart: StartOptions | null = null;
  private startError: string | null = null;
  /** the start screen's last difficulty/weirdness (used for demo runs and "same world again") */
  runOptions: { difficulty: Difficulty; weirdness: number } = { difficulty: 'normal', weirdness: 0.4 };

  // rooms (MP3) --------------------------------------------------------------
  /** the game server's room endpoints (null: a static build without a server) */
  private readonly endpoint: RoomsEndpoint | null = roomsEndpoint(pageBuild(), location);
  private flow: RoomFlow | null = null;
  private flowLoad: Promise<RoomFlow | null> | null = null;
  private flowFailed = false;

  constructor(
    private uiRoot: HTMLElement,
    readonly canvasHost: HTMLElement,
  ) {
    this.settings = loadSettings(DEFAULT_TRANSPORT, TRANSPORTS);
    this.audio = new AudioBridge(this.settings.audio);
    document.documentElement.lang = getLanguage();
    this.ui = createUi(uiRoot, this.callbacks());
    void this.refreshServerPresets();
    preloadRenderer();
    if (this.endpoint) {
      void this.roomFlow().then((f) => f?.refreshRooms());
      setInterval(() => {
        if (this.screen === 'start' && !this.flow?.link && !document.hidden) void this.flow?.refreshRooms();
      }, ROOM_LIST_MS);
    }
  }

  /** asks the backend which presets it holds keys for (backend transport only) */
  private async refreshServerPresets(): Promise<void> {
    if (!TRANSPORTS.includes('backend')) return;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const info = await fetchServerInfo(SERVER_URL, { signal: ctl.signal }).finally(() => clearTimeout(timer));
      this.server = { kind: 'ok', configured: new Set(info.presets.filter((p) => p.configured).map((p) => p.id)), codeRequired: info.codeRequired };
    } catch {
      this.server = { kind: 'unreachable' };
    }
    if (this.screen === 'start') this.render();
  }

  private serverConfigured(): ReadonlySet<string> | null {
    return this.server.kind === 'ok' ? this.server.configured : null;
  }

  /** the LLM the settings give for play (GM and NPC voice), or null (demo/offline GM) */
  provider(): LLMProvider | null {
    if (this.settings.provider.preset === OFFLINE_PRESET) return null;
    const cfg = activeProvider(this.settings);
    const code = this.settings.accessCode?.trim();
    if (cfg.transport === 'backend' && this.server.kind === 'ok' && this.server.codeRequired && !code) return null;
    return providerFromSettings(cfg, this.serverConfigured(), { backendUrl: SERVER_URL, ...(code ? { backendHeaders: { 'x-anyworld-code': code } } : {}) });
  }

  /** worlds can be created: a working provider, or the offline demo generator */
  canGenerate(): boolean {
    return this.settings.provider.preset === OFFLINE_PRESET ? worldIndex().length > 0 : !!this.provider();
  }

  /** the UI language picker (start screen, settings) */
  languageView(): UiViewModel['language'] {
    return { current: getLanguage(), options: availableLanguages() };
  }

  /** switch the UI language: the overlay is rebuilt in the new language, the run goes on */
  setLanguage(code: string): void {
    setLanguage(code);
    this.ui.destroy();
    this.ui = createUi(this.uiRoot, this.callbacks());
    this.render();
  }

  // ---------------------------------------------------------------------------
  // view
  // ---------------------------------------------------------------------------

  settingsView(): SettingsView | null {
    if (!this.settingsOpen) return null;
    return {
      // labels, regions and notes in the UI language (issues/M5-settings-presets-english.md)
      presets: listPresets().map((p) => localizedPreset(p)),
      current: this.settings,
      transports: TRANSPORTS,
      offlineDemo: true,
      music: this.screen === 'game',
      ...(TRANSPORTS.includes('backend') ? { serverPresets: this.server.kind === 'ok' ? [...this.server.configured] : this.server.kind === 'unreachable' ? null : [] } : {}),
      ...(this.server.kind === 'ok' && this.server.codeRequired ? { codeRequired: true } : {}),
    };
  }

  prefs(): { animationSpeed: number; reduceMotion: boolean } {
    return { animationSpeed: this.settings.animationSpeed, reduceMotion: this.settings.reduceMotion };
  }

  startView(): StartView {
    const worlds = worldIndex();
    const lang = getLanguage();
    const demos: DemoWorldView[] = demoWorldsFor(worlds, promptLibrary(), lang).map((w) => ({
      id: w.id,
      title: w.meta.title,
      tagline: w.meta.tagline,
      genre: w.meta.genre,
      ...(w.color ? { color: w.color } : {}),
      language: w.meta.language || 'en',
    }));
    const prompts: InspirationPrompt[] = localizedInspiration(promptLibrary(), new Set(worlds.map((w) => w.id)), lang);
    const saved = loadRun();
    const canGenerate = this.canGenerate();
    const recent: RecentWorldView[] = generatedWorlds()
      .reverse()
      .map((w) => ({
        id: w.id,
        title: w.world.meta.title,
        tagline: w.world.meta.tagline,
        genre: w.world.meta.genre,
        color: w.world.palette.primary,
        language: w.world.meta.language || 'en',
        source: recentSource(w),
        savedAt: w.savedAt ?? 0,
      }));
    return {
      prompts,
      demos,
      savedRun: saved && hasWorld(saved.worldId) ? { worldTitle: saved.worldTitle, playerName: saved.playerName, areaName: saved.areaName, turn: saved.turn } : null,
      canGenerate,
      providerLabel: this.provider() ? providerLabel(this.settings.provider) : null,
      providerStatus: providerStatus(activeProvider(this.settings), this.server, canGenerate, { gm: this.settings.gm, accessCode: this.settings.accessCode }),
      recent,
      canImport: true,
      defaults: { difficulty: this.runOptions.difficulty, weirdness: this.runOptions.weirdness },
      ...(this.endpoint ? { rooms: this.flow?.roomsCardView() ?? { status: this.flowFailed ? 'unavailable' : 'loading', rooms: [] } } : {}),
    };
  }

  render(): void {
    if (this.screen === 'game' && this.controller) {
      this.controller.render();
      return;
    }
    // (in a room between two runs, the controller is being relaunched: the lobby view meanwhile)
    if ((this.screen === 'lobby' || this.screen === 'game') && this.flow?.link) {
      this.ui.render(this.flow.lobbyVm());
      return;
    }
    if (this.screen === 'loading' && this.generation) {
      const view = this.generation.view();
      this.ui.render({
        screen: 'loading',
        theme: { palette: DEFAULT_PALETTE, vocabulary: defaultVocabulary() },
        loading: view.error && this.genHint ? { ...view, error: withHint(view.error, this.genHint) } : view,
        settings: this.settingsView(),
        prefs: this.prefs(),
        language: this.languageView(),
      });
      return;
    }
    const vm: UiViewModel = {
      screen: 'start',
      theme: { palette: DEFAULT_PALETTE, vocabulary: defaultVocabulary() },
      start: this.startView(),
      settings: this.settingsView(),
      prefs: this.prefs(),
      language: this.languageView(),
      ...(this.flow?.sheetView ? { profileSheet: this.flow.sheetView } : {}),
    };
    this.ui.render(vm);
    if (this.startError) {
      this.ui.toast(this.startError, 'warn');
      this.startError = null;
    }
  }

  // ---------------------------------------------------------------------------
  // runs
  // ---------------------------------------------------------------------------

  /** three.js lives in its own chunk (render/lazy.ts): fetched while the start screen is up */
  async ensureRenderer(): Promise<Renderer> {
    if (!this.renderer) {
      const { Renderer } = await loadRenderer();
      this.renderer ??= new Renderer(this.canvasHost, { quality: this.settings.quality ?? 'auto', reduceMotion: this.settings.reduceMotion || undefined });
    }
    return this.renderer;
  }

  private async launch(session: GameSession, entry: WorldEntry): Promise<void> {
    this.controller?.dispose();
    const renderer = await this.ensureRenderer();
    this.canvasHost.hidden = false;
    this.screen = 'game';
    const app = this;
    const ai = await runAi({
      // GM off: no AI calls in play; the recorded/offline GM answers instead
      provider: this.settings.gm === false ? null : this.provider(),
      worldId: recordingsKey(entry),
      loadRecordings: async (id) => (recordedWorldKeys().includes(id) ? loadBundledRecordings(id) : []),
    });
    session.audioListener = (u) => this.audio.update(u);
    this.controller = new GameController(session, {
      ...(ai.director ? { director: ai.director } : {}),
      dialogue: ai.dialogue,
      gmTimeoutMs: ai.gmTimeoutMs,
      // the UI is rebuilt when the language changes: always use the current one
      get ui() {
        return app.ui;
      },
      renderer,
      canvasHost: this.canvasHost,
      extraVm: () => ({ settings: this.settingsView(), language: this.languageView() }),
    });
    // keep the address bar on this run: reloading resumes it (boot.ts) instead of starting over
    setAddress(runUrl(session.worldId, session.state.seed));
    void this.audio.startRun(session.world, session.state.area.index);
    await this.controller.start();
    document.body.dataset.ready = '1';
  }

  async playWorld(id: string, seed = randomSeed(), opts?: Pick<StartOptions, 'difficulty' | 'weirdness'>): Promise<boolean> {
    if (opts) this.runOptions = { difficulty: opts.difficulty, weirdness: opts.weirdness };
    const entry = await loadWorld(id);
    if (!entry) {
      this.showStart(t('app.noWorld', { id }));
      return false;
    }
    clearRun();
    await this.launch(this.newSession(entry, seed), entry);
    return true;
  }

  private newSession(entry: WorldEntry, seed: number): GameSession {
    return new GameSession({
      world: entry.world,
      worldId: entry.id,
      seed,
      prefs: this.prefs(),
      difficulty: this.runOptions.difficulty,
      weirdness: this.runOptions.weirdness,
      onboarding: !onboardingSeen(entry.id),
    });
  }

  async continueRun(): Promise<boolean> {
    const run = loadRun();
    const entry = run ? await loadWorld(run.worldId) : undefined;
    if (!run || !entry) {
      clearRun();
      this.showStart(t('app.savedMissing'));
      return false;
    }
    let session: GameSession;
    try {
      session = new GameSession({
        world: entry.world,
        worldId: entry.id,
        seed: 0,
        saved: run.state,
        gmLog: run.gmLog,
        prefs: this.prefs(),
        ...(run.difficulty ? { difficulty: run.difficulty } : {}),
        ...(run.weirdness !== undefined ? { weirdness: run.weirdness } : {}),
        ...(run.rules ? { rules: run.rules } : {}),
        ...(run.hooks ? { hooks: run.hooks } : {}),
        onboarding: !onboardingSeen(run.worldId),
      });
      this.runOptions = { difficulty: session.difficulty, weirdness: session.weirdness };
    } catch (e) {
      console.warn('[anyworld] saved run is unreadable:', e);
      clearRun();
      this.showStart(t('app.savedBroken'));
      return false;
    }
    await this.launch(session, entry);
    return true;
  }

  /**
   * Creates a world with the configured LLM (loading screen with progress; the bot play-test runs in
   * a Web Worker), keeps it in this browser and starts a run in it. Failures stay on the loading
   * screen with Try again / Back.
   */
  async createWorld(opts: StartOptions): Promise<boolean> {
    const language = opts.language ?? getLanguage();
    const surpriseSeed = randomSeed();
    let provider: LLMProvider | null;
    let origin: string | undefined;
    if (this.settings.provider.preset === OFFLINE_PRESET) {
      // offline demo: "create" a recorded world that fits; the pipeline (validation, bots) runs for real
      const pick = pickDemoWorld(worldIndex(), { prompt: opts.surprise ? '' : opts.prompt, language, seed: surpriseSeed }, promptLibrary());
      const full = pick ? await loadBundledWorld(pick.id) : undefined;
      provider = full ? demoGenerator(full.id, full.world, { latencyMs: 250 }) : null;
      origin = full?.id;
    } else provider = this.provider();
    if (!provider) {
      const problem = providerProblem(activeProvider(this.settings), this.server, this.settings.accessCode);
      if (problem) this.ui.toast(problemText(problem), 'warn');
      this.settingsOpen = true;
      this.render();
      return false;
    }
    this.genHint = null;
    this.lastStart = opts;
    this.runOptions = { difficulty: opts.difficulty, weirdness: opts.weirdness };
    this.generation?.cancel();
    this.controller?.dispose();
    this.controller = null;
    const gen = new WorldGeneration(
      provider,
      {
        prompt: opts.prompt,
        surprise: opts.surprise || !opts.prompt.trim(),
        difficulty: opts.difficulty,
        weirdness: opts.weirdness,
        language,
        recentWorlds: generatedWorlds()
          .slice(-5)
          .map((w) => w.world.meta.title),
        surpriseSeed,
      },
      {
        balancer: workerBalancer(() => new Worker(new URL('../llm/balance-worker.ts', import.meta.url), { type: 'module' })),
        onChange: () => {
          if (this.generation === gen && this.screen === 'loading') this.render();
        },
        offline: this.settings.provider.preset === OFFLINE_PRESET,
      },
    );
    this.generation = gen;
    this.screen = 'loading';
    this.canvasHost.hidden = true;
    this.render();
    let world;
    try {
      world = await gen.run();
    } catch (e) {
      console.warn('[anyworld] world generation failed:', e);
      if (this.generation === gen) {
        this.genHint = generationHint(e, this.settings.provider);
        this.render();
      }
      return false;
    }
    if (this.generation !== gen || gen.signal.aborted) return false;
    this.generation = null;
    const entry = rememberWorld(world, randomSeed(), { source: 'generated', ...(origin ? { origin } : {}) });
    clearRun();
    await this.launch(this.newSession(entry, randomSeed()), entry);
    return true;
  }

  showStart(error?: string): void {
    this.flow?.closeRoom();
    this.generation?.cancel();
    this.generation = null;
    this.audio.stopRun();
    setAddress(location.pathname);
    this.controller?.dispose();
    this.controller = null;
    this.screen = 'start';
    this.canvasHost.hidden = true;
    this.startError = error ?? null;
    this.render();
    document.body.dataset.ready = '1';
  }

  // ---------------------------------------------------------------------------
  // world files (DESIGN §12: export / import)
  // ---------------------------------------------------------------------------

  /** saves a world as `<title>.anyworld.json` (a browser download) */
  async exportWorld(id: string): Promise<boolean> {
    const entry = await loadWorld(id);
    if (!entry) {
      this.ui.toast(t('app.noWorld', { id }), 'warn');
      return false;
    }
    const file = exportWorldFile(entry.world);
    try {
      const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      console.warn('[anyworld] world export failed:', e);
      this.ui.toast(t('world.export.failed'), 'warn');
      return false;
    }
    this.ui.toast(t('world.export.ok', { file: file.filename }), 'info');
    return true;
  }

  /** validates a world file and keeps it under "Your worlds"; returns the new id */
  importWorld(file: WorldFileInput): string | null {
    const r = parseWorldFile(file.text);
    if (!r.ok) {
      console.warn(`[anyworld] world import of ${file.name} failed:`, r.kind, r.details);
      this.ui.toast(tx(r.key, { details: r.details.slice(0, 2).join('; ') }, r.kind), 'warn');
      return null;
    }
    const entry = rememberWorld(r.world, randomSeed(), { source: 'imported' });
    if (!entry.stored) {
      // no room left (the saved run's world is never evicted for it): say so instead of "opened"
      this.ui.toast(t('world.import.error.noRoom', { title: r.world.meta.title }), 'warn');
      return null;
    }
    this.ui.toast(t('world.import.ok', { title: r.world.meta.title }), 'info');
    if (this.screen === 'start') this.render();
    return entry.id;
  }

  forgetWorld(id: string): boolean {
    const entry = findStoredWorld(id);
    if (!entry?.generated || !forgetWorld(id)) return false;
    this.ui.toast(t('world.forgotten', { title: entry.world.meta.title }), 'info');
    if (this.screen === 'start') this.render();
    return true;
  }

  // ---------------------------------------------------------------------------
  // callbacks
  // ---------------------------------------------------------------------------

  private callbacks(): UiCallbacks {
    const ctl = () => (this.screen === 'game' ? this.controller : null);
    return {
      onAction: (a) => ctl()?.onAction(a),
      onIntent: (i) => ctl()?.onIntent(i),
      onDialogueReply: (i) => ctl()?.onDialogueReply(i),
      onDialogueLeave: () => ctl()?.onDialogueLeave(),
      onTrade: (t) => ctl()?.onTrade(t),
      onDismissNarration: (id) => ctl()?.onDismissNarration(id),
      onPlayDemo: (id, opts) => void this.playWorld(id, undefined, opts),
      onContinue: () => void this.continueRun(),
      onStart: (opts) => {
        // no AI to invent a world (offline demo or no usable provider): "Surprise me" plays a random demo world
        if (opts.surprise && (this.settings.provider.preset === OFFLINE_PRESET || !this.provider())) {
          const pick = pickDemoWorld(worldIndex(), { prompt: '', language: opts.language ?? getLanguage(), seed: randomSeed() });
          if (pick) {
            void this.playWorld(pick.id, undefined, opts);
            return;
          }
        }
        if (this.canGenerate()) void this.createWorld(opts);
        else {
          const problem = providerProblem(activeProvider(this.settings), this.server, this.settings.accessCode);
          this.ui.toast(problem ? problemText(problem) : t('app.noGenerator'), 'info');
        }
      },
      onOpenSettings: (open) => {
        this.settingsOpen = open;
        this.flow?.link?.setMenu('settings', open);
        this.render();
      },
      onSettings: (saved) => {
        const before = this.settings;
        // keys stay with the provider they were typed for (issues/M5-api-key-leaks-across-presets.md)
        const s = reconcileApiKeys(before, saved);
        this.settings = s;
        saveSettings(s);
        this.audio.applySettings(s.audio);
        this.renderer?.setQuality(s.quality ?? 'auto');
        if (s.reduceMotion !== before.reduceMotion) this.renderer?.setReduceMotion(s.reduceMotion);
        if (this.controller) this.controller.session.prefs = this.prefs();
        this.settingsOpen = false;
        this.flow?.link?.setMenu('settings', false);
        this.render();
        void this.refreshServerPresets();
      },
      onEnd: (choice) => {
        const s = this.controller?.session;
        if (choice === 'same_world' && s) void this.playWorld(s.worldId);
        else this.showStart();
      },
      onCancelLoading: () => this.showStart(),
      onRetryLoading: () => (this.lastStart ? void this.createWorld(this.lastStart) : this.showStart()),
      onLanguage: (code) => this.setLanguage(code),
      onExportWorld: (id) => void this.exportWorld(id),
      onImportWorld: (file) => void this.importWorld(file),
      onForgetWorld: (id) => void this.forgetWorld(id),
      onMountMusic: (host) => void this.audio.mountPanel(host),
      onRoom: (i) => void this.roomFlow().then((f) => f?.onRoom(i)),
    };
  }

  // ---------------------------------------------------------------------------
  // rooms (MP3): the flow lives in room/flow.ts, loaded lazily with the room runtime
  // ---------------------------------------------------------------------------

  /** the room flow (null: this build has no server, or its code could not be loaded) */
  private roomFlow(): Promise<RoomFlow | null> {
    if (!this.endpoint) return Promise.resolve(null);
    const endpoint = this.endpoint;
    this.flowLoad ??= import('./room/flow').then(
      (m) => (this.flow = new m.RoomFlow(this, endpoint)),
      (e) => {
        console.warn('[anyworld] the room code could not be loaded:', e);
        this.flowFailed = true;
        if (this.screen === 'start') this.render();
        return null;
      },
    );
    return this.flowLoad;
  }

  /** the automation handle of the room this page is in (e2e-mp specs, debugging) */
  get room(): RoomHandle | null {
    return this.flow?.handle ?? null;
  }

  /** joins a room by its code (a ?room= link) */
  async joinRoom(code: string): Promise<boolean> {
    const f = await this.roomFlow();
    if (!f) {
      this.showStart(t(this.endpoint ? 'room.unavailable' : 'room.noServer'));
      return false;
    }
    return f.joinRoom(code);
  }

  /** "Leave room" (the single-player save is untouched) */
  leaveRoom(): void {
    if (this.flow) this.flow.leaveRoom();
    else this.showStart();
  }

}

/**
 * Phone platform details (DESIGN §6b): draw under the notch / home bar (the CSS keeps content inside
 * env(safe-area-inset-*)), no page pinch-zoom or double-tap zoom while playing (the map has its own
 * pinch), no pull-to-refresh (CSS overscroll-behavior).
 */
function setupMobile(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const want = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';
  if (meta && meta.content !== want) meta.content = want;
  // iOS Safari ignores user-scalable=no; its own pinch gesture events must be cancelled instead
  // (only in a run: the start screen and settings stay zoomable for reading)
  const stop = (e: Event) => {
    if (document.getElementById('ui-root')?.dataset.screen === 'game') e.preventDefault();
  };
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('gesturechange', stop, { passive: false });
  // double-tap zoom is off through CSS (touch-action: manipulation on the overlay, none on the map).
  // Audio is unlocked by the audio module's own first-gesture hook, which AudioBridge installs when
  // the lazily loaded module arrives (so the audio chunk is not fetched on the start screen).
}

async function boot(): Promise<void> {
  setupMobile();
  const uiRoot = document.getElementById('ui-root');
  const canvasHost = document.getElementById('game-canvas');
  if (!uiRoot || !canvasHost) throw new Error('index.html is missing #ui-root or #game-canvas');
  const app = new App(uiRoot, canvasHost);
  window.__anyworld = app;
  // never clear the autosaved run on boot: a reloaded or reopened link resumes it, and a link to
  // another world opens the start screen (Continue / pick a world) instead of discarding it
  const saved = loadRun();
  const route = bootRoute(location.search, saved && hasWorld(saved.worldId) ? saved : null, worldTitle);
  if (route.kind === 'new') await app.playWorld(route.worldId, route.seed);
  else if (route.kind === 'continue') await app.continueRun();
  // a room link (MP3): join it (the stored seat or profile; the name sheet the first time); a build
  // without a server says so
  else if (route.kind === 'room') {
    if (!roomsEndpoint(pageBuild(), location)) app.showStart(t('room.noServer'));
    else {
      app.showStart();
      await app.joinRoom(route.code);
    }
  }
  else app.showStart(route.notice);
}

/** puts a failure hint after the error itself, before the generic "try again or play a demo" line */
function withHint(error: string, hint: string): string {
  const tail = t('gen.errorHint');
  return error.endsWith(tail) ? `${error.slice(0, -tail.length).trimEnd()} ${hint} ${tail}` : `${error} ${hint}`;
}

function setAddress(url: string): void {
  try {
    const next = new URL(url, location.href);
    if (next.href !== location.href) history.replaceState(history.state, '', next.href);
  } catch {
    /* history can be unavailable (sandboxed frames); the run itself is unaffected */
  }
}

boot().catch((e) => {
  console.error('[anyworld] failed to start:', e);
  const root = document.getElementById('ui-root');
  if (root) root.textContent = t('app.failed', { error: e instanceof Error ? e.message : String(e) });
});
