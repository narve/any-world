/**
 * GameUi — the overlay UI root. The integrator creates it once:
 *
 *   const ui = createUi(document.getElementById('ui-root')!, callbacks);
 *   ui.render(viewModel);             // after every state change
 *   ui.showActorTooltip(view, {x, y}) // renderer hover pick
 *
 * The UI owns the keyboard (see input.ts) and turns keys/clicks into callbacks: engine
 * PlayerActions via onAction, everything else via onIntent and the other callbacks.
 */
import type { PlayerAction } from '../../engine/types';
import type { ActorTooltipView, GameView, SlotItemView, TileTooltipView, UiCallbacks, UiIntent, UiViewModel } from './viewmodel';
import { dataKey, h, icon, ICONS, setChildren } from './dom';
import { applyTheme } from './theme';
import { DEFAULT_VOCABULARY } from './format';
import { attachKeyboard, computeLayer, type InputLayer, type InputVerbs, type KeyboardBinding, type UiCommand } from './input';
import { activateSlot, decodeDrag, DRAG_MIME, encodeDrag, moveAction, navigateSlot, slotMenu, type ActivateResult, type SlotMenuEntry, assignQuickAction } from './slots';
import { actorCard, tileCard, Tooltip, type UiContext } from './components/common';
import { Hud } from './components/hud';
import { MessageLog } from './components/log';
import { NarrationCard } from './components/narration';
import { ToastStack, toastLabel, type ToastEntry } from './toasts';
import { Hotbar } from './components/hotbar';
import { Backpack, type BackpackState } from './components/backpack';
import { ChoiceModal, DialoguePanel, LevelUpModal, TradePanel } from './components/modals';
import { HelpOverlay, RulesPanel, rulesBadge } from './components/panels';
import { EndScreen, LoadingScreen, SettingsDialog, StartScreen } from './components/screens';

export interface GameUi {
  readonly root: HTMLElement;
  render(vm: UiViewModel): void;
  /**
   * hover/look tooltip for an actor at viewport coords; null hides. `avoid` (the player's screen
   * position) puts the card on the far side of the target so it never covers the player.
   */
  showActorTooltip(actor: ActorTooltipView | null, at?: { x: number; y: number }, avoid?: { x: number; y: number } | null): void;
  showTileTooltip(tile: TileTooltipView | null, at?: { x: number; y: number }, avoid?: { x: number; y: number } | null): void;
  /**
   * Where the conversation partner stands on screen: the dialogue panel docks on the side away from
   * the speaker and the player (null = default placement).
   */
  placeDialogue(at: { speaker: { x: number; y: number } | null; player: { x: number; y: number } } | null): void;
  /** fade the log while it covers the player or someone next to them */
  setLogObscuring(on: boolean): void;
  /**
   * viewport rectangles of the panels that sit over the map (for overlap checks): the log, and
   * every visible HUD panel (player card, top strip, rules, log, hotbar) in `hud`
   */
  panelRects(): { log: DOMRect | null; hud: DOMRect[] };
  hideTooltip(): void;
  setBackpackOpen(open: boolean): void;
  /** short transient notice */
  toast(text: string, tone?: 'info' | 'warn'): void;
  /** current keyboard layer (for the integrator's own input decisions) */
  layer(): InputLayer;
  /** true while a panel/modal is consuming input */
  isBlocking(): boolean;
  destroy(): void;
}

export interface CreateUiOptions {
  /** keyboard event source (default window) */
  keyboardTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** randomness for inspiration shuffling (UI only; never the engine) */
  rand?: () => number;
}

const NO_VERBS: InputVerbs = { talk: false, sneak: false, search: false, persuade: false };

export function createUi(root: HTMLElement, cb: UiCallbacks, opts: CreateUiOptions = {}): GameUi {
  return new UiRoot(root, cb, opts);
}

class UiRoot implements GameUi {
  readonly root: HTMLElement;
  private vm: UiViewModel | null = null;
  private ctxValue: UiContext = { vocab: DEFAULT_VOCABULARY };
  private themeKey = '';
  private kb: KeyboardBinding;

  private tooltip: Tooltip;
  private gameEl: HTMLElement;
  private stripWrap: HTMLElement;
  private modeBanner: HTMLElement;
  private busyEl: HTMLElement;
  private rulesBadgeWrap: HTMLElement;
  private objectiveEl: HTMLElement;
  private interactEl: HTMLElement;
  private hintsEl: HTMLElement;
  private hintsKey = '';
  private vignette: HTMLElement;
  private dialogueSide: 'left' | 'right' | null = null;
  private toasts: HTMLElement;
  private toastEls = new Map<number, HTMLElement>();
  private toastStack = new ToastStack({ onChange: (e, l) => this.renderToasts(e, l) });

  private hud = new Hud();
  private log = new MessageLog();
  private narration: NarrationCard;
  private hotbar: Hotbar;
  private backpack: Backpack;
  private dialogue: DialoguePanel;
  private choice: ChoiceModal;
  private levelUp: LevelUpModal;
  private trade: TradePanel;
  private help: HelpOverlay;
  private rules: RulesPanel;
  private start: StartScreen;
  private loading: LoadingScreen;
  private end: EndScreen;
  private settings: SettingsDialog;

  private bp: BackpackState = { open: false, cursor: 0, grabbed: null, menuIndex: null };
  private helpOpen = false;
  private rulesOpen = false;
  private lastScreen: UiViewModel['screen'] | null = null;
  private rulesBadgeKey = '';

  constructor(root: HTMLElement, private cb: UiCallbacks, opts: CreateUiOptions) {
    this.root = root;
    root.classList.add('aw-ui');
    root.textContent = '';
    this.tooltip = new Tooltip(root);
    const ctx = () => this.ctxValue;

    this.narration = new NarrationCard((id) => cb.onDismissNarration?.(id));
    const bindSlot = (el: HTMLElement, slot: number) => this.bindSlot(el, slot);
    this.hotbar = new Hotbar(
      {
        activate: (i) => this.activate(i),
        openMenu: (i) => this.openBackpackAt(i, true),
        toggleBackpack: () => this.setBackpackOpen(!this.bp.open),
        toggleRules: () => this.setRulesOpen(!this.rulesOpen),
        toggleHelp: () => this.setHelpOpen(!this.helpOpen),
        bindSlot,
      },
      this.tooltip,
      ctx,
    );
    this.backpack = new Backpack(
      {
        select: (i) => this.selectSlot(i),
        activate: (i) => this.activate(i),
        openMenu: (i) => this.openBackpackAt(i, true),
        runEntry: (slot, e) => this.runEntry(slot, e),
        close: () => this.setBackpackOpen(false),
        bindSlot,
      },
      this.tooltip,
      ctx,
    );
    this.dialogue = new DialoguePanel({
      reply: (i, t) => cb.onDialogueReply?.(i, t),
      leave: () => cb.onDialogueLeave?.(),
      persuade: (id) => this.intent({ type: 'persuade', targetId: id }),
      trade: (id) => this.intent({ type: 'open_trade', npcId: id }),
    });
    this.choice = new ChoiceModal((i) => cb.onAction({ type: 'choose_option', index: i }));
    this.levelUp = new LevelUpModal((perkId) => cb.onAction({ type: 'choose_perk', perkId }), ctx);
    this.trade = new TradePanel((t) => cb.onTrade?.(t), this.tooltip, ctx);
    this.help = new HelpOverlay(() => this.setHelpOpen(false));
    this.rules = new RulesPanel(() => this.setRulesOpen(false));
    this.start = new StartScreen(cb, opts.rand);
    this.loading = new LoadingScreen(cb);
    this.end = new EndScreen(cb);
    this.settings = new SettingsDialog(cb);

    this.modeBanner = h('div', { class: 'aw-mode-banner', role: 'status', hidden: true });
    this.busyEl = h('div', { class: 'aw-busy', role: 'status', hidden: true });
    this.objectiveEl = h('div', { class: 'aw-objective', role: 'status', hidden: true });
    this.interactEl = h('div', { class: 'aw-interact-hint', hidden: true });
    this.hintsEl = h('aside', { class: 'aw-hints', 'aria-label': 'First steps', hidden: true });
    this.vignette = h('div', { class: 'aw-vignette', 'aria-hidden': 'true', hidden: true });
    this.stripWrap = h('div', { class: 'aw-top-centre' }, this.hud.strip, this.objectiveEl, this.modeBanner, this.busyEl, this.interactEl);
    this.rulesBadgeWrap = h('div', { class: 'aw-top-right' });
    this.toasts = h('div', { class: 'aw-toasts', 'aria-live': 'polite' });

    this.gameEl = h(
      'div',
      { class: 'aw-game', hidden: true },
      this.vignette,
      h('div', { class: 'aw-top-left' }, this.hud.panel),
      this.stripWrap,
      h('div', { class: 'aw-top-right-col' }, this.rulesBadgeWrap, this.rules.el),
      h('div', { class: 'aw-bottom-left' }, this.hintsEl, this.log.el),
      h('div', { class: 'aw-bottom-centre' }, this.hotbar.el),
      this.narration.el,
      this.backpack.el,
      this.dialogue.el,
      this.trade.el,
      this.levelUp.el,
      this.choice.el,
      this.help.el,
    );
    root.append(this.start.el, this.loading.el, this.end.el, this.gameEl, this.settings.el, this.toasts, this.tooltip.el);
    for (const s of [this.start.el, this.loading.el, this.end.el]) s.hidden = true;

    this.kb = attachKeyboard(
      () => this.layer(),
      () => this.vm?.game?.verbs ?? NO_VERBS,
      (cmd) => this.command(cmd),
      opts.keyboardTarget,
    );
  }

  // -------------------------------------------------------------------------
  // rendering
  // -------------------------------------------------------------------------

  render(vm: UiViewModel): void {
    this.vm = vm;
    this.ctxValue = { vocab: vm.theme.vocabulary ?? DEFAULT_VOCABULARY };
    const tk = dataKey(vm.theme.palette);
    if (tk !== this.themeKey) {
      this.themeKey = tk;
      applyTheme(this.root, vm.theme.palette);
    }
    const prefs = vm.prefs ?? { animationSpeed: 1, reduceMotion: false };
    this.root.toggleAttribute('data-reduce-motion', prefs.reduceMotion);
    this.root.style.setProperty('--anim-speed', String(prefs.animationSpeed || 1));
    this.narration.setSpeed(prefs.animationSpeed, prefs.reduceMotion);

    const screenChanged = vm.screen !== this.lastScreen;
    this.lastScreen = vm.screen;
    this.start.el.hidden = vm.screen !== 'start';
    this.loading.el.hidden = vm.screen !== 'loading';
    this.end.el.hidden = vm.screen !== 'end';
    this.gameEl.hidden = vm.screen !== 'game';
    this.root.dataset.screen = vm.screen;

    if (vm.screen === 'start' && vm.start) {
      this.start.update(vm.start);
      if (screenChanged) queueMicrotask(() => this.start.el.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true }));
    }
    if (vm.screen === 'loading' && vm.loading) this.loading.update(vm.loading);
    if (vm.screen === 'end' && vm.end) this.end.update(vm.end, this.ctxValue.vocab);
    if (vm.screen !== 'game' && screenChanged) {
      this.bp = { open: false, cursor: 0, grabbed: null, menuIndex: null };
      this.helpOpen = false;
      this.rulesOpen = false;
      this.tooltip.hideAt();
    }
    if (vm.screen === 'game' && vm.game) this.renderGame(vm.game);
    else this.help.update(false, NO_VERBS, this.ctxValue);
    this.settings.update(vm.settings ?? null);
  }

  private renderGame(g: GameView): void {
    const ctx = this.ctxValue;
    this.hud.update(g.hud, ctx);
    this.log.update(g.log, ctx.vocab);
    this.renderAids(g);
    this.narration.update(g.narration);
    this.hotbar.update(g.slots, g.mode === 'target' ? (g.targetingSlot ?? null) : null);
    this.backpack.update(g.slots, this.bp);
    // a pending level-up takes precedence (the engine rejects other choices
    // until a perk is picked), so nothing may cover or trap focus above it
    const lv = !!g.levelUp;
    this.dialogue.update(lv ? null : g.dialogue);
    this.trade.update(lv ? null : g.trade);
    this.levelUp.update(g.levelUp);
    this.choice.update(lv ? null : g.choice);
    this.help.update(this.helpOpen, g.verbs, ctx, g.transitionName);
    this.rules.update(this.rulesOpen, g.goalSummary, g.rules, g.quests);

    const rk = dataKey([g.rules, this.rulesOpen]);
    if (rk !== this.rulesBadgeKey) {
      this.rulesBadgeKey = rk;
      this.rulesBadgeWrap.textContent = '';
      if (!this.rulesOpen) this.rulesBadgeWrap.appendChild(rulesBadge(g.rules, () => this.setRulesOpen(true)));
    }

    if (g.mode === 'look') {
      this.modeBanner.hidden = false;
      this.modeBanner.textContent = 'Looking — arrows move the cursor · Enter describe · x / Esc done';
    } else if (g.mode === 'target') {
      const it = g.targetingSlot !== undefined ? g.slots[g.targetingSlot] : null;
      this.modeBanner.hidden = false;
      this.modeBanner.textContent = it?.aimsDirection
        ? `Aim ${it.name} — arrow keys pick a direction (or click) · Enter confirm · Esc cancel`
        : `Choose a target${it ? ` for ${it.name}` : ''} — arrows or click · Enter confirm · Esc cancel`;
    } else {
      this.modeBanner.hidden = true;
    }
    this.busyEl.hidden = !g.busy;
    this.busyEl.textContent = g.busy ?? '';
    if (g.canTransition) this.stripWrap.dataset.exit = g.transitionName;
    else delete this.stripWrap.dataset.exit;
    this.gameEl.classList.toggle('can-transition', g.canTransition);
  }

  /** objective line, interact hint, first-run hints and the danger vignette */
  private renderAids(g: GameView): void {
    const obj = g.objective ?? '';
    const hint = g.objectiveHint ?? '';
    this.objectiveEl.hidden = (!obj && !hint) || g.mode !== 'normal';
    const full = obj && hint ? `${obj} — ${hint}` : obj || hint;
    if (this.objectiveEl.dataset.tip !== full) {
      // the goal may be clamped; the hint has its own line so it is never the part cut off
      // (issues/M2-objective-hint-truncated.md)
      setChildren(
        this.objectiveEl,
        obj ? h('span', { class: 'aw-objective-goal' }, obj) : null,
        hint ? h('span', { class: 'aw-objective-hint' }, hint) : null,
      );
      this.objectiveEl.dataset.tip = full;
    }
    const ih = g.interactHint ?? '';
    this.interactEl.hidden = !ih;
    if (this.interactEl.textContent !== ih) this.interactEl.textContent = ih;

    const hk = dataKey(g.hints ?? null);
    if (hk !== this.hintsKey) {
      this.hintsKey = hk;
      const hints = g.hints ?? [];
      this.hintsEl.hidden = !hints.length;
      setChildren(
        this.hintsEl,
        h('div', { class: 'aw-hints-head' }, h('span', null, 'First steps'), h('button', { type: 'button', class: 'aw-icon-btn aw-hints-close', 'aria-label': 'Hide hints', onclick: () => this.intent({ type: 'dismiss_hints' }) }, icon(ICONS.close))),
        h('ul', null, hints.map((t) => h('li', null, t))),
      );
    }

    // screen-edge vignette in the colour of whatever is draining health
    const drain = (g.hud.danger ?? []).find((d) => d.draining);
    this.vignette.hidden = !drain;
    if (drain) {
      this.vignette.style.setProperty('--vignette', drain.color);
      this.vignette.dataset.level = drain.level;
    }
  }

  private rerenderGame(): void {
    if (this.vm?.screen === 'game' && this.vm.game) this.renderGame(this.vm.game);
  }

  // -------------------------------------------------------------------------
  // public helpers
  // -------------------------------------------------------------------------

  showActorTooltip(actor: ActorTooltipView | null, at?: { x: number; y: number }, avoid?: { x: number; y: number } | null): void {
    if (!actor || !at) return this.tooltip.hideAt();
    const verbs = this.vm?.game?.verbs;
    const hint = actor.isNpc && verbs?.talk && actor.faction !== 'hostile' ? 'Walk into them or press t to talk' : undefined;
    this.tooltip.showAt(actorCard(actor, this.ctxValue, hint), at.x, at.y, avoid);
  }

  showTileTooltip(tile: TileTooltipView | null, at?: { x: number; y: number }, avoid?: { x: number; y: number } | null): void {
    if (!tile || !at) return this.tooltip.hideAt();
    this.tooltip.showAt(tileCard(tile), at.x, at.y, avoid);
  }

  placeDialogue(at: { speaker: { x: number; y: number } | null; player: { x: number; y: number } } | null): void {
    let side: 'left' | 'right' | null = null;
    if (at) {
      const w = this.root.getBoundingClientRect().width || window.innerWidth;
      // dock on the half of the screen that holds neither the speaker nor the player
      const xs = [at.player.x, ...(at.speaker ? [at.speaker.x] : [])];
      const mid = xs.reduce((a, b) => a + b, 0) / xs.length;
      side = mid > w * 0.5 ? 'left' : 'right';
    }
    if (side === this.dialogueSide) return;
    this.dialogueSide = side;
    for (const el of [this.dialogue.el, this.trade.el]) {
      el.classList.toggle('dock-left', side === 'left');
      el.classList.toggle('dock-right', side === 'right');
    }
  }

  setLogObscuring(on: boolean): void {
    this.log.setObscuring(on);
  }

  panelRects(): { log: DOMRect | null; hud: DOMRect[] } {
    if (this.gameEl.hidden) return { log: null, hud: [] };
    const hud: DOMRect[] = [];
    for (const corner of this.gameEl.querySelectorAll<HTMLElement>(':scope > .aw-top-left, :scope > .aw-top-centre, :scope > .aw-top-right-col, :scope > .aw-bottom-left, :scope > .aw-bottom-centre')) {
      // the corner wrappers can be wider than what they show; measure their visible children
      for (const child of Array.from(corner.children) as HTMLElement[]) {
        if (child.hidden) continue;
        const rc = child.getBoundingClientRect();
        if (rc.width > 0 && rc.height > 0) hud.push(rc);
      }
    }
    return { log: this.log.el.getBoundingClientRect(), hud };
  }

  hideTooltip(): void {
    this.tooltip.hideAt();
  }

  setBackpackOpen(open: boolean): void {
    if (this.bp.open === open) return;
    this.bp = { ...this.bp, open, grabbed: null, menuIndex: null };
    if (open) this.rulesOpen = false;
    this.intent({ type: 'panel', panel: 'backpack', open });
    this.rerenderGame();
    if (!open) this.focusGame();
  }

  toast(text: string, tone: 'info' | 'warn' = 'info'): void {
    this.toastStack.push(text, tone);
  }

  /** mirrors the toast stack into the DOM (identical toasts merge, at most three show) */
  private renderToasts(entries: readonly ToastEntry[], leaving: ReadonlySet<number>): void {
    const live = new Set(entries.map((e) => e.id));
    for (const [id, el] of this.toastEls) {
      if (!live.has(id)) {
        el.remove();
        this.toastEls.delete(id);
      }
    }
    for (const e of entries) {
      let el = this.toastEls.get(e.id);
      if (!el) {
        el = h('div', { class: ['aw-toast', `tone-${e.tone}`] });
        this.toastEls.set(e.id, el);
      }
      const label = toastLabel(e);
      if (el.textContent !== label) {
        el.textContent = label;
        if (e.count > 1) {
          // replay the pulse so a repeated message is noticed without adding a new line
          el.classList.remove('is-bumped');
          void el.offsetWidth;
          el.classList.add('is-bumped');
        }
      }
      el.classList.toggle('is-leaving', leaving.has(e.id));
      this.toasts.appendChild(el); // keeps DOM order = stack order (newest last)
    }
  }

  layer(): InputLayer {
    const vm = this.vm;
    if (!vm) return 'none';
    const g = vm.game;
    return computeLayer({
      screen: vm.screen,
      settingsOpen: !!vm.settings,
      helpOpen: this.helpOpen,
      rulesOpen: this.rulesOpen,
      backpackOpen: this.bp.open,
      menuOpen: this.bp.menuIndex !== null,
      narrationVisible: this.narration.visible,
      choice: !!g?.choice,
      levelUp: !!g?.levelUp,
      dialogue: !!g?.dialogue,
      trade: !!g?.trade,
      mode: g?.mode ?? 'normal',
    });
  }

  isBlocking(): boolean {
    const l = this.layer();
    return l !== 'game' && l !== 'narration' && l !== 'look' && l !== 'target';
  }

  destroy(): void {
    this.kb.detach();
    this.root.textContent = '';
    this.root.classList.remove('aw-ui');
  }

  // -------------------------------------------------------------------------
  // commands
  // -------------------------------------------------------------------------

  private act(a: PlayerAction): void {
    this.cb.onAction(a);
  }

  private intent(i: UiIntent): void {
    this.cb.onIntent?.(i);
  }

  private slots(): (SlotItemView | null)[] {
    return this.vm?.game?.slots ?? [];
  }

  private focusGame(): void {
    const a = document.activeElement as HTMLElement | null;
    if (a && this.root.contains(a) && a !== document.body) a.blur();
  }

  private setHelpOpen(open: boolean): void {
    this.helpOpen = open;
    this.intent({ type: 'panel', panel: 'help', open });
    if (this.vm?.screen === 'game') this.rerenderGame();
  }

  private setRulesOpen(open: boolean): void {
    this.rulesOpen = open;
    // the badge (and the pill the mouse may be on) is replaced by the panel
    this.tooltip.clear();
    if (open && this.bp.open) this.bp = { ...this.bp, open: false, grabbed: null, menuIndex: null };
    this.intent({ type: 'panel', panel: 'rules', open });
    this.rerenderGame();
  }

  private openBackpackAt(slot: number, menu: boolean): void {
    const wasOpen = this.bp.open;
    this.bp = { open: true, cursor: slot, grabbed: null, menuIndex: menu && this.slots()[slot] ? 0 : null };
    this.rulesOpen = false;
    if (!wasOpen) this.intent({ type: 'panel', panel: 'backpack', open: true });
    this.rerenderGame();
  }

  private selectSlot(i: number): void {
    if (this.bp.grabbed !== null) {
      const a = moveAction(this.slots(), this.bp.grabbed, i);
      this.bp = { ...this.bp, cursor: i, grabbed: null, menuIndex: null };
      if (a) this.act(a);
    } else {
      this.bp = { ...this.bp, cursor: i, menuIndex: null };
    }
    this.rerenderGame();
  }

  private activate(slot: number): void {
    const g = this.vm?.game;
    if (g?.mode === 'target' && g.targetingSlot === slot) {
      this.intent({ type: 'confirm_cursor' });
      return;
    }
    this.runResult(activateSlot(this.slots(), slot), slot);
  }

  private runResult(r: ActivateResult | { kind: 'grab' }, slot: number): void {
    if (!r) return;
    switch (r.kind) {
      case 'action':
        this.act(r.action);
        break;
      case 'intent':
        if (r.intent.type === 'begin_target' && this.bp.open) this.setBackpackOpen(false);
        this.intent(r.intent);
        break;
      case 'inspect':
        this.openBackpackAt(slot, false);
        break;
      case 'blocked':
        this.toast(r.reason, 'warn');
        break;
      case 'grab':
        this.bp = { ...this.bp, open: true, cursor: slot, grabbed: slot, menuIndex: null };
        this.rerenderGame();
        break;
    }
  }

  private runEntry(slot: number, e: SlotMenuEntry): void {
    if (e.disabled) return;
    this.bp = { ...this.bp, menuIndex: null };
    this.runResult(e.result, slot);
    this.rerenderGame();
  }

  private bindSlot(el: HTMLElement, slot: number): void {
    el.addEventListener('dragstart', (e: DragEvent) => {
      if (!this.slots()[slot] || !e.dataTransfer) return e.preventDefault();
      e.dataTransfer.setData(DRAG_MIME, encodeDrag(slot));
      e.dataTransfer.setData('text/plain', encodeDrag(slot));
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('is-dragging');
      this.tooltip.hide();
    });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
    el.addEventListener('dragover', (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (Array.from(e.dataTransfer.types).includes(DRAG_MIME) || Array.from(e.dataTransfer.types).includes('text/plain')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('is-drop');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
    el.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      el.classList.remove('is-drop');
      const from = decodeDrag(e.dataTransfer?.getData(DRAG_MIME) || e.dataTransfer?.getData('text/plain'));
      if (from === null) return;
      const a = moveAction(this.slots(), from, slot);
      if (a) {
        if (this.bp.open) this.bp = { ...this.bp, cursor: slot, grabbed: null, menuIndex: null };
        this.act(a);
      }
    });
  }

  private command(cmd: UiCommand): void {
    const layer = this.layer();
    const g = this.vm?.game;
    switch (layer) {
      case 'settings':
        if (cmd.type === 'close') this.cb.onOpenSettings?.(false);
        return;
      case 'help':
        if (cmd.type === 'close') this.setHelpOpen(false);
        return;
      case 'rules':
        if (cmd.type === 'close') this.setRulesOpen(false);
        return;
      case 'choice':
        if (cmd.type === 'option') this.choice.option(cmd.index);
        else if (cmd.type === 'nav') this.choice.modal.moveFocus(cmd.dir === 'n' || cmd.dir === 'w' ? -1 : 1);
        else if (cmd.type === 'help') this.setHelpOpen(true);
        return;
      case 'levelup':
        if (cmd.type === 'option') this.levelUp.option(cmd.index);
        else if (cmd.type === 'nav') this.levelUp.modal.moveFocus(cmd.dir === 'n' || cmd.dir === 'w' ? -1 : 1);
        else if (cmd.type === 'help') this.setHelpOpen(true);
        return;
      case 'trade':
        if (cmd.type === 'close') this.cb.onTrade?.({ type: 'close' });
        else if (cmd.type === 'option') this.trade.option(cmd.index);
        else if (cmd.type === 'nav') this.trade.modal.moveFocus(cmd.dir === 'n' || cmd.dir === 'w' ? -1 : 1);
        else if (cmd.type === 'help') this.setHelpOpen(true);
        return;
      case 'dialogue':
        if (cmd.type === 'close') this.cb.onDialogueLeave?.();
        else if (cmd.type === 'option') this.dialogue.option(cmd.index);
        else if (cmd.type === 'nav') this.dialogue.modal.moveFocus(cmd.dir === 'n' || cmd.dir === 'w' ? -1 : 1);
        else if (cmd.type === 'persuade') this.dialogue.persuade();
        else if (cmd.type === 'trade') this.dialogue.trade();
        else if (cmd.type === 'help') this.setHelpOpen(true);
        return;
      case 'menu':
        return this.menuCommand(cmd);
      case 'backpack':
        return this.backpackCommand(cmd);
      case 'look':
        if (cmd.type === 'close') this.intent({ type: 'look', on: false });
        else if (cmd.type === 'nav') this.intent({ type: 'look_move', dir: cmd.dir });
        else if (cmd.type === 'confirm') this.intent({ type: 'confirm_cursor' });
        else this.common(cmd);
        return;
      case 'target':
        if (cmd.type === 'close') this.intent({ type: 'cancel' });
        else if (cmd.type === 'nav') this.intent({ type: 'target_move', dir: cmd.dir });
        else if (cmd.type === 'confirm') this.intent({ type: 'confirm_cursor' });
        else if (cmd.type === 'slot') {
          if (g?.targetingSlot === cmd.index) this.intent({ type: 'confirm_cursor' });
          else {
            this.intent({ type: 'cancel' });
            this.activate(cmd.index);
          }
        } else this.common(cmd);
        return;
      case 'narration':
        if (cmd.type === 'skip') {
          this.narration.skip();
          return;
        }
        return this.gameCommand(cmd);
      case 'game':
        return this.gameCommand(cmd);
      default:
        return;
    }
  }

  private common(cmd: UiCommand): void {
    if (cmd.type === 'help') this.setHelpOpen(true);
    else if (cmd.type === 'rotate') this.intent({ type: 'rotate_camera', dir: cmd.dir });
    else if (cmd.type === 'zoom') this.intent({ type: 'zoom', delta: cmd.delta });
  }

  private gameCommand(cmd: UiCommand): void {
    switch (cmd.type) {
      case 'move':
        return this.act({ type: 'move', dir: cmd.dir });
      case 'wait':
        return this.act({ type: 'wait' });
      case 'slot':
        return this.activate(cmd.index);
      case 'pickup':
        return this.act({ type: 'pickup' });
      case 'backpack':
        return this.setBackpackOpen(true);
      case 'look':
        return this.intent({ type: 'look', on: true });
      case 'transition':
        return this.act({ type: 'transition' });
      case 'talk':
        return this.intent({ type: 'talk' });
      case 'persuade':
        return this.intent({ type: 'persuade' });
      case 'search':
        return this.act({ type: 'search' });
      case 'sneak':
        return this.act({ type: 'toggle_sneak' });
      case 'rules':
        return this.setRulesOpen(true);
      case 'interact':
        return this.intent({ type: 'interact' });
      case 'close':
        if (this.narration.visible) this.narration.skip();
        return;
      default:
        return this.common(cmd);
    }
  }

  private backpackCommand(cmd: UiCommand): void {
    const slots = this.slots();
    switch (cmd.type) {
      case 'close':
        if (this.bp.grabbed !== null) {
          this.bp = { ...this.bp, grabbed: null };
          this.rerenderGame();
        } else this.setBackpackOpen(false);
        return;
      case 'nav':
        this.bp = { ...this.bp, cursor: navigateSlot(this.bp.cursor, cmd.dir) };
        this.rerenderGame();
        return;
      case 'confirm':
        if (this.bp.grabbed !== null) return this.selectSlot(this.bp.cursor);
        if (slots[this.bp.cursor]) {
          this.bp = { ...this.bp, menuIndex: 0 };
          this.rerenderGame();
        }
        return;
      case 'option': {
        const a = assignQuickAction(slots, this.bp.cursor, cmd.index);
        if (a) this.act(a);
        return;
      }
      case 'menu_key':
        return this.menuKey(cmd.key);
      case 'help':
        return this.setHelpOpen(true);
      default:
        return;
    }
  }

  private menuKey(key: string): void {
    const entries = slotMenu(this.slots(), this.bp.cursor);
    const e = entries.find((x) => x.key === key || (key === 'b' && x.id === 'to_backpack') || (key === 'q' && x.id === 'to_quick'));
    if (e) this.runEntry(this.bp.cursor, e);
  }

  private menuCommand(cmd: UiCommand): void {
    const entries = slotMenu(this.slots(), this.bp.cursor);
    const idx = this.bp.menuIndex ?? 0;
    switch (cmd.type) {
      case 'close':
        this.bp = { ...this.bp, menuIndex: null };
        this.rerenderGame();
        return;
      case 'nav': {
        if (!entries.length) return;
        const n = (idx + (cmd.dir === 'n' ? -1 : 1) + entries.length) % entries.length;
        this.bp = { ...this.bp, menuIndex: n };
        this.rerenderGame();
        return;
      }
      case 'confirm': {
        const e = entries[idx];
        if (e) this.runEntry(this.bp.cursor, e);
        return;
      }
      case 'menu_key':
        return this.menuKey(cmd.key);
      default:
        return;
    }
  }
}
