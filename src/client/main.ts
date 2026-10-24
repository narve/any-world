/**
 * App shell: the start screen (demo worlds, saved run, settings), one GameController per run, and
 * the end screen. URL shortcuts: `?world=<bundled id>&seed=<n>` starts that world straight away
 * (demo links, e2e tests) or resumes its autosaved run; `?continue=1` resumes the autosaved run.
 * The address bar always names the run on screen (see boot.ts), so a reload continues it.
 */
import { createUi, type GameUi, type Settings, type StartView, type UiCallbacks, type UiViewModel, type InspirationPrompt, type DemoWorldView, type SettingsView, type StartOptions, type Difficulty } from './ui/index';
import { DEFAULT_PALETTE } from './ui/index';
import { defaultVocabulary } from './ui/format';
import type { Renderer } from './render/index';
import { loadRenderer, preloadRenderer } from './render/lazy';
import { listPresets } from '../llm/presets';
import { fetchServerPresets } from '../llm/transport';
import type { LLMProvider } from '../llm/types';
import { workerBalancer } from '../llm/balance-worker';
import { loadBundledRecordings, recordedWorldKeys } from '../llm/recordings-bundle';
import { bundledWorlds, findWorld, generatedWorlds, rememberWorld, type WorldEntry } from './worlds';
import { providerFromSettings, providerLabel, runAi, WorldGeneration } from './ai';
import { clearRun, loadRun, loadSettings, onboardingSeen, saveSettings } from './storage';
import { availableLanguages, getLanguage, setLanguage, t } from './i18n/index';
import { GameSession } from './session';
import { inspirationPrompts, promptLibrary } from './prompts';
import { GameController } from './game-controller';
import { bootRoute, runUrl } from './boot';

declare global {
  interface Window {
    /** automation handle for e2e tests and debugging */
    __anyworld?: App;
  }
}

const DEFAULT_TRANSPORT: 'direct' | 'backend' = typeof __ANYWORLD_DEFAULT_TRANSPORT__ !== 'undefined' ? __ANYWORLD_DEFAULT_TRANSPORT__ : 'backend';

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
  private screen: 'start' | 'loading' | 'game' = 'start';
  /** presets the backend says it can serve (null until asked, or when it cannot be reached) */
  private serverConfigured: Set<string> | null = null;
  private generation: WorldGeneration | null = null;
  private lastStart: StartOptions | null = null;
  private startError: string | null = null;
  /** the start screen's last difficulty/weirdness (used for demo runs and "same world again") */
  private runOptions: { difficulty: Difficulty; weirdness: number } = { difficulty: 'normal', weirdness: 0.4 };

  constructor(
    private uiRoot: HTMLElement,
    private canvasHost: HTMLElement,
  ) {
    this.settings = loadSettings(DEFAULT_TRANSPORT);
    document.documentElement.lang = getLanguage();
    this.ui = createUi(uiRoot, this.callbacks());
    void this.refreshServerPresets();
    preloadRenderer();
  }

  /** asks the backend which presets it holds keys for (backend transport only) */
  private async refreshServerPresets(): Promise<void> {
    if (this.settings.provider.transport !== 'backend') return;
    try {
      const list = await fetchServerPresets();
      this.serverConfigured = new Set(list.filter((p) => p.configured).map((p) => p.id));
    } catch {
      this.serverConfigured = null;
    }
    if (this.screen === 'start') this.render();
  }

  /** the LLM the settings give, or null (demo worlds only) */
  provider(): LLMProvider | null {
    return providerFromSettings(this.settings.provider, this.serverConfigured);
  }

  /** the UI language picker (start screen, settings) */
  private languageView(): UiViewModel['language'] {
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

  private settingsView(): SettingsView | null {
    if (!this.settingsOpen) return null;
    return {
      presets: [...listPresets()],
      current: this.settings,
      transports: DEFAULT_TRANSPORT === 'direct' ? ['direct'] : ['direct', 'backend'],
    };
  }

  private prefs() {
    return { animationSpeed: this.settings.animationSpeed, reduceMotion: this.settings.reduceMotion };
  }

  startView(): StartView {
    const worlds = bundledWorlds();
    const demos: DemoWorldView[] = worlds.map((w) => ({
      id: w.id,
      title: w.world.meta.title,
      tagline: w.world.meta.tagline,
      genre: w.world.meta.genre,
      color: w.world.palette.primary,
      language: w.world.meta.language || 'en',
    }));
    const prompts: InspirationPrompt[] = inspirationPrompts(promptLibrary(), new Set(worlds.map((w) => w.id)));
    const saved = loadRun();
    return {
      prompts,
      demos,
      savedRun: saved && findWorld(saved.worldId) ? { worldTitle: saved.worldTitle, playerName: saved.playerName, areaName: saved.areaName, turn: saved.turn } : null,
      canGenerate: !!this.provider(),
      providerLabel: this.provider() ? providerLabel(this.settings.provider) : null,
      defaults: { difficulty: this.runOptions.difficulty, weirdness: this.runOptions.weirdness },
    };
  }

  render(): void {
    if (this.screen === 'game' && this.controller) {
      this.controller.render();
      return;
    }
    if (this.screen === 'loading' && this.generation) {
      this.ui.render({
        screen: 'loading',
        theme: { palette: DEFAULT_PALETTE, vocabulary: defaultVocabulary() },
        loading: this.generation.view(),
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
  private async ensureRenderer(): Promise<Renderer> {
    if (!this.renderer) {
      const { Renderer } = await loadRenderer();
      this.renderer ??= new Renderer(this.canvasHost);
    }
    return this.renderer;
  }

  private async launch(session: GameSession): Promise<void> {
    this.controller?.dispose();
    const renderer = await this.ensureRenderer();
    this.canvasHost.hidden = false;
    this.screen = 'game';
    const app = this;
    const ai = await runAi({
      provider: this.provider(),
      worldId: session.worldId,
      loadRecordings: async (id) => (recordedWorldKeys().includes(id) ? loadBundledRecordings(id) : []),
    });
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
    await this.controller.start();
    document.body.dataset.ready = '1';
  }

  async playWorld(id: string, seed = randomSeed(), opts?: Pick<StartOptions, 'difficulty' | 'weirdness'>): Promise<boolean> {
    if (opts) this.runOptions = { difficulty: opts.difficulty, weirdness: opts.weirdness };
    const entry = findWorld(id);
    if (!entry) {
      this.showStart(t('app.noWorld', { id }));
      return false;
    }
    clearRun();
    await this.launch(this.newSession(entry, seed));
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
    const entry = run ? findWorld(run.worldId) : undefined;
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
    await this.launch(session);
    return true;
  }

  /**
   * Creates a world with the configured LLM (loading screen with progress; the bot play-test runs in
   * a Web Worker), keeps it in this browser and starts a run in it. Failures stay on the loading
   * screen with Try again / Back.
   */
  async createWorld(opts: StartOptions): Promise<boolean> {
    const provider = this.provider();
    if (!provider) {
      this.settingsOpen = true;
      this.render();
      return false;
    }
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
        language: opts.language ?? getLanguage(),
        recentWorlds: generatedWorlds()
          .slice(-5)
          .map((w) => w.world.meta.title),
        surpriseSeed: randomSeed(),
      },
      {
        balancer: workerBalancer(() => new Worker(new URL('../llm/balance-worker.ts', import.meta.url), { type: 'module' })),
        onChange: () => {
          if (this.generation === gen && this.screen === 'loading') this.render();
        },
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
      return false;
    }
    if (this.generation !== gen || gen.signal.aborted) return false;
    this.generation = null;
    const entry = rememberWorld(world, randomSeed());
    clearRun();
    await this.launch(this.newSession(entry, randomSeed()));
    return true;
  }

  showStart(error?: string): void {
    this.generation?.cancel();
    this.generation = null;
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
        if (this.provider()) void this.createWorld(opts);
        else this.ui.toast(t('app.noGenerator'), 'info');
      },
      onOpenSettings: (open) => {
        this.settingsOpen = open;
        this.render();
      },
      onSettings: (s) => {
        this.settings = s;
        saveSettings(s);
        if (this.controller) this.controller.session.prefs = this.prefs();
        this.settingsOpen = false;
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
    };
  }
}

async function boot(): Promise<void> {
  const uiRoot = document.getElementById('ui-root');
  const canvasHost = document.getElementById('game-canvas');
  if (!uiRoot || !canvasHost) throw new Error('index.html is missing #ui-root or #game-canvas');
  const app = new App(uiRoot, canvasHost);
  window.__anyworld = app;
  // never clear the autosaved run on boot: a reloaded or reopened link resumes it, and a link to
  // another world opens the start screen (Continue / pick a world) instead of discarding it
  const saved = loadRun();
  const route = bootRoute(location.search, saved && findWorld(saved.worldId) ? saved : null, (id) => findWorld(id)?.world.meta.title);
  if (route.kind === 'new') await app.playWorld(route.worldId, route.seed);
  else if (route.kind === 'continue') await app.continueRun();
  else app.showStart(route.notice);
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
