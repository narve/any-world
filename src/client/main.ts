/**
 * App shell: the start screen (demo worlds, saved run, settings), one GameController per run, and
 * the end screen. URL shortcuts: `?world=<bundled id>&seed=<n>` starts that world straight away
 * (demo links, e2e tests) or resumes its autosaved run; `?continue=1` resumes the autosaved run.
 * The address bar always names the run on screen (see boot.ts), so a reload continues it.
 */
import { createUi, type GameUi, type Settings, type StartView, type UiCallbacks, type UiViewModel, type InspirationPrompt, type DemoWorldView, type SettingsView } from './ui/index';
import { DEFAULT_PALETTE, DEFAULT_VOCABULARY } from './ui/index';
import { Renderer } from './render/index';
import { listPresets } from '../llm/presets';
import { bundledWorlds, findWorld, type WorldEntry } from './worlds';
import { clearRun, loadRun, loadSettings, saveSettings } from './storage';
import { GameSession } from './session';
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
  readonly ui: GameUi;
  /** created with the first run (WebGL is not needed for the start screen) */
  renderer: Renderer | null = null;
  controller: GameController | null = null;
  private settings: Settings;
  private settingsOpen = false;
  private screen: 'start' | 'game' = 'start';
  private startError: string | null = null;

  constructor(
    private uiRoot: HTMLElement,
    private canvasHost: HTMLElement,
  ) {
    this.settings = loadSettings(DEFAULT_TRANSPORT);
    this.ui = createUi(uiRoot, this.callbacks());
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
    }));
    const prompts: InspirationPrompt[] = worlds.map((w) => ({
      prompt: w.world.meta.prompt || w.world.meta.tagline,
      genre: w.world.meta.genre,
      tags: w.world.meta.tags,
      teaser: w.world.meta.title,
      worldId: w.id,
    }));
    const saved = loadRun();
    return {
      prompts,
      demos,
      savedRun: saved && findWorld(saved.worldId) ? { worldTitle: saved.worldTitle, playerName: saved.playerName, areaName: saved.areaName, turn: saved.turn } : null,
      // live world generation needs the generation pipeline (milestone M3); until then the
      // start screen offers the recorded worlds
      canGenerate: false,
      providerLabel: null,
    };
  }

  render(): void {
    if (this.screen === 'game' && this.controller) {
      this.controller.render();
      return;
    }
    const vm: UiViewModel = {
      screen: 'start',
      theme: { palette: DEFAULT_PALETTE, vocabulary: DEFAULT_VOCABULARY },
      start: this.startView(),
      settings: this.settingsView(),
      prefs: this.prefs(),
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

  private ensureRenderer(): Renderer {
    if (!this.renderer) this.renderer = new Renderer(this.canvasHost);
    return this.renderer;
  }

  private async launch(session: GameSession): Promise<void> {
    this.controller?.dispose();
    const renderer = this.ensureRenderer();
    this.canvasHost.hidden = false;
    this.screen = 'game';
    this.controller = new GameController(session, {
      ui: this.ui,
      renderer,
      canvasHost: this.canvasHost,
      extraVm: () => ({ settings: this.settingsView() }),
    });
    // keep the address bar on this run: reloading resumes it (boot.ts) instead of starting over
    setAddress(runUrl(session.worldId, session.state.seed));
    await this.controller.start();
    document.body.dataset.ready = '1';
  }

  async playWorld(id: string, seed = randomSeed()): Promise<boolean> {
    const entry = findWorld(id);
    if (!entry) {
      this.showStart(`No recorded world called "${id}".`);
      return false;
    }
    clearRun();
    await this.launch(this.newSession(entry, seed));
    return true;
  }

  private newSession(entry: WorldEntry, seed: number): GameSession {
    return new GameSession({ world: entry.world, worldId: entry.id, seed, prefs: this.prefs() });
  }

  async continueRun(): Promise<boolean> {
    const run = loadRun();
    const entry = run ? findWorld(run.worldId) : undefined;
    if (!run || !entry) {
      clearRun();
      this.showStart('The saved run could not be found.');
      return false;
    }
    let session: GameSession;
    try {
      session = new GameSession({ world: entry.world, worldId: entry.id, seed: 0, saved: run.state, gmLog: run.gmLog, prefs: this.prefs() });
    } catch (e) {
      console.warn('[anyworld] saved run is unreadable:', e);
      clearRun();
      this.showStart('The saved run could not be loaded.');
      return false;
    }
    await this.launch(session);
    return true;
  }

  showStart(error?: string): void {
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
      onPlayDemo: (id) => void this.playWorld(id),
      onContinue: () => void this.continueRun(),
      onStart: () => {
        // canGenerate is false, so the UI opens settings instead of calling this; keep a safe
        // answer for any other caller
        this.ui.toast('Creating new worlds needs the AI world builder; pick a demo world for now.', 'info');
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
      },
      onEnd: (choice) => {
        const s = this.controller?.session;
        if (choice === 'same_world' && s) void this.playWorld(s.worldId);
        else this.showStart();
      },
      onCancelLoading: () => this.showStart(),
      onRetryLoading: () => this.showStart(),
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
  if (root) root.textContent = `AnyWorld failed to start: ${e instanceof Error ? e.message : String(e)}`;
});
