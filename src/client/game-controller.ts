/**
 * GameController — wires one run together in the browser: GameSession (engine + controller state)
 * ↔ Renderer (three.js scene) ↔ overlay UI. It applies every session Outcome: re-renders the UI,
 * syncs the renderer with the engine events, shows toasts/tooltips, drives click-to-travel and
 * autosaves. The app shell (main.ts) owns the UI root and the screens around a run.
 */
import type { Dir, PlayerAction, Pos } from '../engine/types';
import type { Renderer } from './render/index';
import type { GameUi, TradeIntent, UiIntent, UiViewModel } from './ui/index';
import { attachPointer } from './ui/index';
import type { GameSession, Outcome } from './session';
import { clearRun, saveRun } from './storage';

const TRAVEL_STEP_MS = 70;

export interface ControllerHost {
  ui: GameUi;
  renderer: Renderer;
  /** the element the renderer's canvas lives in (mouse input) */
  canvasHost: HTMLElement;
  /** extra view-model fields from the shell (e.g. an open settings dialog) */
  extraVm?: () => Partial<UiViewModel>;
  /** the run ended (won or lost) */
  onEnded?: () => void;
}

export class GameController {
  private disposers: (() => void)[] = [];
  private travelGen = 0;
  private disposed = false;
  private lastHover: Pos | null = null;
  private endedNotified = false;

  constructor(readonly session: GameSession, private host: ControllerHost) {}

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
      renderer.zoom(e.deltaY > 0 ? 1 : -1);
    };
    // any key press stops click-to-travel (the UI handles the key itself)
    const onKey = () => this.stopTravel();
    this.host.canvasHost.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey, true);
    this.disposers.push(
      () => pointer.detach(),
      () => this.host.canvasHost.removeEventListener('wheel', onWheel),
      () => window.removeEventListener('keydown', onKey, true),
    );
    this.render();
    await renderer.sync(this.session.state, []);
    renderer.rig.settle();
    this.autosave();
  }

  dispose(): void {
    this.disposed = true;
    this.stopTravel();
    for (const d of this.disposers.splice(0)) d();
    this.host.renderer.highlightTiles([]);
    this.host.ui.hideTooltip();
  }

  render(): void {
    if (this.disposed) return;
    const vm = this.session.viewModel(this.host.extraVm?.() ?? {});
    this.host.ui.render(vm);
    this.host.renderer.highlightTiles(this.session.highlights(), this.session.mode === 'target' ? '#ff6b5a' : '#ffd166');
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
    if (i.type === 'click_tile' || i.type === 'begin_target' || i.type === 'look') this.stopTravel();
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
    else if (out.describe) {
      const at = renderer.tileToScreen(out.describe.pos);
      if (out.describe.actor) ui.showActorTooltip(out.describe.actor, at);
      else if (out.describe.tile) ui.showTileTooltip(out.describe.tile, at);
      else ui.hideTooltip();
    }
    if (out.changed) {
      if (!opts.quiet) ui.hideTooltip();
      void renderer.sync(this.session.state, out.events);
      this.autosave();
      if (this.session.ended && !this.endedNotified) {
        this.endedNotified = true;
        this.host.onEnded?.();
      }
    }
    if (out.travel) void this.runTravel();
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
        await renderer.sync(this.session.state, outcome.events);
        this.autosave();
        if (this.session.ended && !this.endedNotified) {
          this.endedNotified = true;
          this.host.onEnded?.();
        }
      }
      if (!more) return;
      await new Promise((r) => setTimeout(r, this.session.prefs.reduceMotion ? 0 : TRAVEL_STEP_MS));
    }
  }

  // ---------------------------------------------------------------------------
  // test / automation helpers
  // ---------------------------------------------------------------------------

  /** a keyboard-free move in map directions (e2e tests) */
  moveMap(dir: Dir): void {
    this.stopTravel();
    this.apply(this.session.act({ type: 'move', dir }));
  }

  get hovered(): Pos | null {
    return this.lastHover;
  }
}
