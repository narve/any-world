/**
 * GameController — wires one run together in the browser: GameSession (engine + controller state)
 * ↔ Renderer (three.js scene) ↔ overlay UI ↔ game master. It applies every session Outcome:
 * re-renders the UI, syncs the renderer with the engine events, shows toasts/tooltips, drives
 * click-to-travel, feeds GM hooks to the GM director and autosaves. The app shell (main.ts) owns
 * the UI root and the screens around a run.
 *
 * The GM never blocks a turn: hooks go to a GmRunner (async queue, timeout, offline fallback) and
 * its answers are applied between turns through session.applyGm. Answers for an area the player
 * has already left are dropped; an answer that would open a choice while another is open waits
 * until the player is free.
 */
import type { Dir, PlayerAction, Pos } from '../engine/types';
import type { Renderer } from './render/index';
import type { GameUi, TradeIntent, UiIntent, UiViewModel } from './ui/index';
import { attachPointer } from './ui/index';
import type { GameSession, Outcome } from './session';
import { clearRun, markOnboardingSeen, saveRun } from './storage';
import { GmRunner, OfflineGmDirector, type GmDirector, type GmResult } from './gm-director';
import { MapOverlay } from './map-overlay';
import type { LlmDialogue } from '../llm/gm-runtime';
import { voiceTurn } from './ai';

const TRAVEL_STEP_MS = 70;
/** GM answers waiting for the player to finish a choice are kept at most this long (turns) */
const HOLD_TURNS = 30;

export interface ControllerHost {
  ui: GameUi;
  renderer: Renderer;
  /** the element the renderer's canvas lives in (mouse input) */
  canvasHost: HTMLElement;
  /** extra view-model fields from the shell (e.g. an open settings dialog) */
  extraVm?: () => Partial<UiViewModel>;
  /** the run ended (won or lost) */
  onEnded?: () => void;
  /** the GM brain (default: the offline director); the offline director is always the fallback */
  director?: GmDirector;
  /** per-request GM time limit (ms) */
  gmTimeoutMs?: number;
  /** NPC voice (ai.ts): each conversation turn is voiced by the LLM; absent = the engine's lines */
  dialogue?: LlmDialogue | null;
}

/** renderer methods newer renderers may offer (feature-detected) */
interface OptionalRenderer {
  itemThumbnail?: (defId: string) => string | null | undefined;
}

export class GameController {
  private disposers: (() => void)[] = [];
  private travelGen = 0;
  private disposed = false;
  private lastHover: Pos | null = null;
  private endedNotified = false;
  readonly gm: GmRunner;
  private held: { result: GmResult; turn: number }[] = [];
  private overlay: MapOverlay | null = null;
  private raf = 0;
  private thumbCache = new Map<string, string | null>();
  private voiceAbort: AbortController | null = null;

  constructor(
    readonly session: GameSession,
    private host: ControllerHost,
  ) {
    const offline = new OfflineGmDirector();
    this.gm = new GmRunner(host.director ?? offline, {
      fallback: offline,
      timeoutMs: host.gmTimeoutMs ?? 8000,
      onResult: (r) => this.onGmResult(r),
      onError: (err, req, who) => console.warn(`[anyworld] GM (${who}) failed on ${req.hook}:`, err),
    });
    const r = host.renderer as Renderer & OptionalRenderer;
    if (typeof r.itemThumbnail === 'function') session.thumbs = (defId) => this.thumb(defId);
  }

  /** builds the scene for the current area and shows the run */
  async start(): Promise<void> {
    const { renderer } = this.host;
    renderer.setWorld(this.session.world);
    renderer.setArea(this.session.state.area);
    this.session.setCameraStep(renderer.cameraStep);
    const pointer = attachPointer(
      this.host.canvasHost,
      (x, y) => renderer.screenToTile(x, y),
      (i) => this.onIntent(i),
    );
    const onWheel = (e: WheelEvent) => {
      if (this.host.ui.isBlocking()) return;
      e.preventDefault();
      // proportional to the wheel (a notch is ~100 px): one notch now moves the camera noticeably
      const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      renderer.zoom(Math.max(-3, Math.min(3, d / 60)));
    };
    // any key press stops click-to-travel (the UI handles the key itself)
    const onKey = () => this.stopTravel();
    this.host.canvasHost.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey, true);
    this.overlay = new MapOverlay(this.host.canvasHost, (p) => renderer.tileToScreen(p as Pos));
    this.overlay.setAvoid(() => this.host.ui.panelRects().hud);
    this.disposers.push(
      () => pointer.detach(),
      () => this.host.canvasHost.removeEventListener('wheel', onWheel),
      () => window.removeEventListener('keydown', onKey, true),
      () => this.overlay?.dispose(),
    );
    this.render();
    await renderer.sync(this.session.state, []);
    renderer.rig.settle();
    this.autosave();
    this.loop();
    this.pumpGm(false);
  }

  dispose(): void {
    this.disposed = true;
    this.voiceAbort?.abort();
    this.stopTravel();
    cancelAnimationFrame(this.raf);
    this.gm.dispose();
    for (const d of this.disposers.splice(0)) d();
    this.overlay = null;
    this.host.renderer.highlightTiles([]);
    this.host.ui.hideTooltip();
  }

  render(): void {
    if (this.disposed) return;
    const vm = this.session.viewModel(this.host.extraVm?.() ?? {});
    this.host.ui.render(vm);
    this.host.renderer.highlightTiles(this.session.highlights(), this.session.mode === 'target' ? '#ff6b5a' : '#ffd166');
    this.updateOverlay();
  }

  // ---------------------------------------------------------------------------
  // UI callbacks (main.ts forwards them while this run is on screen)
  // ---------------------------------------------------------------------------

  onAction(a: PlayerAction): void {
    this.stopTravel();
    this.apply(this.session.uiAction(a));
  }

  onIntent(i: UiIntent): void {
    if (this.disposed) return;
    if (i.type === 'hover_tile') {
      this.lastHover = i.pos;
      this.apply(this.session.intent(i), { quiet: true });
      return;
    }
    if (i.type === 'click_tile' || i.type === 'begin_target' || i.type === 'look' || i.type === 'interact') this.stopTravel();
    if (i.type === 'panel' && i.panel === 'rules' && i.open) {
      this.session.acknowledgeRules();
      queueMicrotask(() => this.render());
    }
    if (i.type === 'dismiss_onboarding' && i.forever) markOnboardingSeen(this.session.worldId);
    this.apply(this.session.intent(i));
  }

  onDialogueReply(index: number): void {
    this.apply(this.session.dialogueReply(index));
  }

  onDialogueLeave(): void {
    this.apply(this.session.dialogueLeave());
  }

  onTrade(t: TradeIntent): void {
    this.apply(this.session.trade(t));
  }

  onDismissNarration(id: string): void {
    this.session.dismissNarration(id);
    this.render();
  }

  // ---------------------------------------------------------------------------
  // applying outcomes
  // ---------------------------------------------------------------------------

  private apply(out: Outcome, opts: { quiet?: boolean } = {}): void {
    if (this.disposed) return;
    const { ui, renderer } = this.host;
    if (out.camera?.rotate) {
      renderer.rotateCamera(out.camera.rotate);
      this.session.setCameraStep(renderer.cameraStep);
    }
    if (out.camera?.zoom) renderer.zoom(out.camera.zoom);
    for (const t of out.toasts) ui.toast(t.text, t.tone);
    this.render();
    if (out.describe === null) ui.hideTooltip();
    else if (out.describe) this.showDescribe(out.describe);
    if (out.changed) {
      // the hovered tile may hold someone whose state just changed (a hit, a status): refresh
      if (!opts.quiet) this.refreshTooltip();
      void renderer.sync(this.session.state, out.events);
      this.autosave();
      this.afterTurn();
    }
    if (out.travel) void this.runTravel();
    this.pumpVoice();
  }

  /** asks the NPC voice for the conversation turn the session is waiting on (never blocks play) */
  private pumpVoice(): void {
    const req = this.session.takeVoiceRequest();
    const dialogue = this.host.dialogue;
    if (!req || !dialogue) return;
    this.voiceAbort?.abort();
    const ac = new AbortController();
    this.voiceAbort = ac;
    const s = this.session;
    void voiceTurn(dialogue, req, { world: s.world, state: s.state, difficulty: s.difficulty, signal: ac.signal }).then((r) => {
      if (!r || this.disposed || ac.signal.aborted) return;
      const out = s.setVoice(req.token, r.response);
      if (s.voiceLine() === null && !out.changed) return;
      this.apply(out, { quiet: true });
    });
  }

  private showDescribe(d: NonNullable<Outcome['describe']>): void {
    const { ui, renderer } = this.host;
    const at = renderer.tileToScreen(d.pos);
    const p = this.session.player().pos;
    const avoid = p.x === d.pos.x && p.y === d.pos.y ? null : renderer.tileToScreen(p);
    if (d.actor) ui.showActorTooltip(d.actor, at, avoid);
    else if (d.tile) ui.showTileTooltip(d.tile, at, avoid);
    else ui.hideTooltip();
  }

  /** re-describe the hovered tile when it holds an actor (new HP, statuses); else hide */
  private refreshTooltip(): void {
    const pos = this.lastHover;
    if (!pos || this.session.ended) return this.host.ui.hideTooltip();
    const d = this.session.describeAt(pos);
    if (d.actor) this.showDescribe({ pos, ...d });
    else this.host.ui.hideTooltip();
  }

  /** after any state change: GM hooks, end of run */
  private afterTurn(): void {
    if (this.session.ended && !this.endedNotified) {
      this.endedNotified = true;
      this.gm.cancelAll();
      this.held = [];
      this.host.onEnded?.();
    }
    this.pumpGm(true);
  }

  private autosave(): void {
    if (this.session.ended) clearRun();
    else saveRun(this.session.savedRun(Date.now()));
  }

  private stopTravel(): void {
    this.travelGen++;
    this.session.stopTravel();
  }

  private async runTravel(): Promise<void> {
    const gen = ++this.travelGen;
    const { renderer } = this.host;
    for (;;) {
      if (gen !== this.travelGen || this.disposed) return;
      if (this.host.ui.isBlocking()) {
        this.session.stopTravel();
        return;
      }
      const { outcome, more } = this.session.travelTick();
      if (outcome.changed) {
        for (const t of outcome.toasts) this.host.ui.toast(t.text, t.tone);
        this.render();
        // a click-attack goes through travel: the hovered actor's card must show the new HP
        this.refreshTooltip();
        await renderer.sync(this.session.state, outcome.events);
        this.autosave();
        this.afterTurn();
      }
      if (!more) return;
      await new Promise((r) => setTimeout(r, this.session.prefs.reduceMotion ? 0 : TRAVEL_STEP_MS));
    }
  }

  // ---------------------------------------------------------------------------
  // game master
  // ---------------------------------------------------------------------------

  /** sends the session's new GM hooks to the runner; an area change drops stale requests first */
  private pumpGm(applyHeld: boolean): void {
    if (this.disposed) return;
    const hooks = this.session.takeHooks();
    if (hooks.some((h) => h.hook === 'area_enter')) {
      this.gm.cancelAll();
      this.held = [];
    }
    for (const h of hooks) this.gm.request(h, this.session.gmContext());
    if (applyHeld) this.applyHeld();
  }

  private onGmResult(r: GmResult): void {
    if (this.disposed || this.session.ended) return;
    if (r.request.area !== this.session.state.area.index) return; // stale: the player moved on
    const st = this.session.state;
    const opensChoice = r.response.actions.some((a) => a.type === 'offer_choice' || a.type === 'trade');
    if (opensChoice && (st.pendingChoice || st.player.pendingPerkChoice)) {
      this.held.push({ result: r, turn: st.turn });
      return;
    }
    this.applyGmResult(r);
  }

  private applyGmResult(r: GmResult): void {
    const out = this.session.applyGm(r.response.actions, { hook: r.request.hook, area: r.request.area });
    if (!out.changed && !out.toasts.length) return;
    this.apply(out, { quiet: true });
  }

  /** GM answers that waited for an open choice to close */
  private applyHeld(): void {
    if (!this.held.length) return;
    const st = this.session.state;
    if (st.pendingChoice || st.player.pendingPerkChoice) {
      this.held = this.held.filter((h) => st.turn - h.turn <= HOLD_TURNS && h.result.request.area === st.area.index);
      return;
    }
    const ready = this.held.splice(0);
    for (const h of ready) if (h.result.request.area === st.area.index) this.applyGmResult(h.result);
  }

  // ---------------------------------------------------------------------------
  // map overlay & per-frame UI checks
  // ---------------------------------------------------------------------------

  private updateOverlay(): void {
    const ov = this.overlay;
    if (!ov) return;
    const s = this.session;
    ov.setPreview(this.host.ui.isBlocking() ? null : s.preview(this.lastHover));
    const st = s.state;
    const ex = st.area.map.exit;
    const seen = (st.area.seen as ArrayLike<number>)[ex.y * st.area.map.width + ex.x] ?? 0;
    const plan = s.world.areas[st.area.index];
    ov.setExit(!s.ended && seen > 0 && plan ? { pos: ex, label: plan.transitionName } : null);
    const pc = st.pendingChoice;
    const speaker = pc?.kind === 'dialogue' && pc.speakerId ? st.area.actors.find((a) => a.id === pc.speakerId) : undefined;
    ov.setSpeaker(speaker ? speaker.pos : null);
    ov.setPlayer(s.ended ? null : s.player().pos);
    ov.setAim(s.ended ? null : s.aim());
    // the conversation panel docks away from the speaker and the player
    const r = this.host.renderer;
    this.host.ui.placeDialogue(speaker ? { speaker: r.tileToScreen(speaker.pos), player: r.tileToScreen(s.player().pos) } : null);
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.session.ended) return;
    this.overlay?.frame();
    this.checkLogOverlap();
  };

  private logCheckAt = 0;

  /** fade the log while the player (or someone next to them) is under it */
  private checkLogOverlap(): void {
    const now = performance.now();
    if (now - this.logCheckAt < 200) return;
    this.logCheckAt = now;
    const rect = this.host.ui.panelRects().log;
    if (!rect || !rect.width) return;
    const s = this.session;
    const p = s.player().pos;
    const r = this.host.renderer;
    const near = [p, ...s.state.area.actors.filter((a) => a.hp > 0 && Math.max(Math.abs(a.pos.x - p.x), Math.abs(a.pos.y - p.y)) === 1).map((a) => a.pos)];
    const pad = 18;
    const covered = near.some((q) => {
      const sp = r.tileToScreen(q);
      return sp.x >= rect.left - pad && sp.x <= rect.right + pad && sp.y >= rect.top - pad && sp.y <= rect.bottom + pad;
    });
    this.host.ui.setLogObscuring(covered);
  }

  private thumb(defId: string): string | undefined {
    if (this.thumbCache.has(defId)) return this.thumbCache.get(defId) ?? undefined;
    let url: string | null = null;
    try {
      url = (this.host.renderer as Renderer & OptionalRenderer).itemThumbnail?.(defId) ?? null;
    } catch (e) {
      console.warn('[anyworld] item thumbnail failed:', e);
    }
    this.thumbCache.set(defId, url);
    return url ?? undefined;
  }

  // ---------------------------------------------------------------------------
  // test / automation helpers
  // ---------------------------------------------------------------------------

  /** a keyboard-free move in map directions (e2e tests) */
  moveMap(dir: Dir): void {
    this.stopTravel();
    this.apply(this.session.act({ type: 'move', dir }));
  }

  /** an engine action in map terms, applied like a UI action (e2e tests) */
  actNow(a: PlayerAction): void {
    this.stopTravel();
    this.apply(this.session.act(a));
  }

  /** applies GM actions now, as if a director had answered `hook` (e2e tests, debugging) */
  gmNow(actions: GmResult['response']['actions'], hook: GmResult['request']['hook'] = 'idle'): void {
    const st = this.session.state;
    this.applyGmResult({ request: { hook, area: st.area.index, turn: st.turn, id: 0 }, response: { actions }, source: 'debug' });
  }

  /** replaces the engine state (e2e set-ups: teleports, injected rules) and redraws */
  async setStateForTest(mutate: (s: GameSession['state']) => void): Promise<void> {
    const st = structuredClone(this.session.state);
    mutate(st);
    this.session.state = st;
    this.render();
    await this.host.renderer.sync(this.session.state, []);
  }

  get hovered(): Pos | null {
    return this.lastHover;
  }
}
