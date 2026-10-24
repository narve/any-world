/**
 * GameSession — the DOM-free half of the game controller. It owns the engine state of one run plus
 * everything the controller adds on top (look/target cursor, narration, dialogue history, trade
 * panel, camera-relative input, click-to-travel), turns UI callbacks into engine actions and builds
 * the UI view model. It never touches the DOM or the renderer: every call returns an `Outcome` that
 * the browser controller (game-controller.ts) applies (renderer sync, toasts, tooltips). That keeps
 * all of the integration logic unit-testable in node (tests/client/session.test.ts).
 */
import type { WorldSpec } from '../schema/world';
import type { ActorInstance, AreaMap, Dir, GameEvent, GameState, LogMessage, PendingChoice, PlayerAction, Pos } from '../engine/types';
import { createGame, describeActor, describeItemDef, deserialize, legalActions, serialize, step } from '../engine/index';
import type {
  ActorTooltipView,
  GameView,
  NarrationView,
  TileTooltipView,
  TradeIntent,
  UiIntent,
  UiViewModel,
} from './ui/viewmodel';
import { dialogueMap, endView, gameView, needsTarget, playerOf, themeOf } from './view';
import { actorAt, cheb, rotateDir, travelStep, visibleHostiles } from './travel';
import type { SavedRun } from './storage';
import { explainInvalid } from './invalid';

const DELTA: Record<Dir, [number, number]> = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };
const HISTORY_LIMIT = 12;

export type Toast = { text: string; tone: 'info' | 'warn' };

/** what the controller must do after a session call */
export interface Outcome {
  /** the engine state changed: sync the renderer with these events */
  changed: boolean;
  events: GameEvent[];
  /** the area index changed (renderer rebuilds the area) */
  areaChanged: boolean;
  toasts: Toast[];
  /** camera commands for the renderer */
  camera?: { rotate?: -1 | 1; zoom?: -1 | 1 };
  /** show a tooltip for this tile (look mode confirm / secondary click); null hides it */
  describe?: { pos: Pos; actor: ActorTooltipView | null; tile: TileTooltipView | null } | null;
  /** a click started click-to-travel: the controller should drive `travelTick()` */
  travel?: boolean;
}

function emptyOutcome(): Outcome {
  return { changed: false, events: [], areaChanged: false, toasts: [] };
}

function merge(a: Outcome, b: Outcome): Outcome {
  return {
    changed: a.changed || b.changed,
    events: [...a.events, ...b.events],
    areaChanged: a.areaChanged || b.areaChanged,
    toasts: [...a.toasts, ...b.toasts],
    camera: b.camera ?? a.camera,
    describe: b.describe !== undefined ? b.describe : a.describe,
    travel: b.travel ?? a.travel,
  };
}

export interface SessionInit {
  world: WorldSpec;
  /** bundled world id (content/worlds/<id>.json), used for saves */
  worldId: string;
  seed: number;
  /** resume from an engine serialize() string instead of starting a new run */
  saved?: string;
  gmLog?: LogMessage[];
  /** a fixed first-area map instead of the generator's (tests) */
  map?: AreaMap;
  /** UI animation preferences carried into the view model */
  prefs?: { animationSpeed: number; reduceMotion: boolean };
}

export class GameSession {
  readonly world: WorldSpec;
  readonly worldId: string;
  readonly seed: number;
  state: GameState;
  mode: GameView['mode'] = 'normal';
  cursor: Pos | null = null;
  targetingSlot: number | undefined;
  narration: NarrationView | null;
  gmLog: LogMessage[];
  history: { who: 'npc' | 'player'; text: string }[] = [];
  tradeOpen = false;
  /** camera yaw step 0..3, mirrored from the renderer */
  cameraStep = 0;
  prefs: { animationSpeed: number; reduceMotion: boolean };
  /** click-to-travel destination */
  travelDest: Pos | null = null;
  private travelSeen = new Set<string>();
  private narrationSeq = 0;

  constructor(init: SessionInit) {
    this.world = init.world;
    this.worldId = init.worldId;
    this.seed = init.seed;
    this.gmLog = init.gmLog ? [...init.gmLog] : [];
    this.prefs = init.prefs ?? { animationSpeed: 1, reduceMotion: false };
    if (init.saved) {
      this.state = deserialize(init.world, init.saved);
      this.narration = null;
    } else {
      this.state = createGame(init.world, { seed: init.seed, ...(init.map ? { map: init.map } : {}) });
      const m = init.world.meta;
      this.narration = { id: 'intro', kind: 'intro', title: m.title, text: m.premise || m.tagline };
    }
  }

  // ---------------------------------------------------------------------------
  // queries
  // ---------------------------------------------------------------------------

  get ended(): boolean {
    return this.state.status !== 'playing';
  }

  player(): ActorInstance {
    return playerOf(this.state);
  }

  viewModel(extra: Partial<UiViewModel> = {}): UiViewModel {
    const theme = themeOf(this.world);
    if (this.ended) return { screen: 'end', theme, end: endView(this.world, this.state), prefs: this.prefs, ...extra };
    const game = gameView(this.world, this.state, {
      gmLog: this.gmLog,
      narration: this.narration,
      mode: this.mode,
      targetingSlot: this.targetingSlot,
      dialogueHistory: this.history,
      tradeOpen: this.tradeOpen,
    });
    return { screen: 'game', theme, game, prefs: this.prefs, ...extra };
  }

  /** tiles the renderer should highlight (look/target cursor) */
  highlights(): Pos[] {
    return this.cursor && this.mode !== 'normal' ? [this.cursor] : [];
  }

  savedRun(now: number): SavedRun {
    const plan = this.world.areas[this.state.area.index];
    return {
      v: 1,
      worldId: this.worldId,
      worldTitle: this.world.meta.title,
      seed: this.state.seed,
      playerName: this.world.player.name,
      areaName: plan?.name ?? '',
      turn: this.state.turn,
      state: serialize(this.state),
      gmLog: this.gmLog,
      savedAt: now,
    };
  }

  private seenAt(p: Pos): number {
    const m = this.state.area.map;
    if (p.x < 0 || p.y < 0 || p.x >= m.width || p.y >= m.height) return 0;
    return (this.state.area.seen as ArrayLike<number>)[p.y * m.width + p.x] ?? 0;
  }

  private inBounds(p: Pos): boolean {
    const m = this.state.area.map;
    return p.x >= 0 && p.y >= 0 && p.x < m.width && p.y < m.height;
  }

  /** tooltip data for a tile: the visible actor standing there, or the terrain + items (if explored) */
  describeAt(pos: Pos): { actor: ActorTooltipView | null; tile: TileTooltipView | null } {
    const seen = this.seenAt(pos);
    if (seen === 0) return { actor: null, tile: null };
    const a = actorAt(this.state, pos);
    if (a && (seen === 2 || a.id === this.state.player.actorId)) {
      const view = describeActor(this.state, a.id);
      const def = a.id === this.state.player.actorId ? undefined : this.world.actors.find((d) => d.id === a.defId);
      const model = def?.model ?? (a.id === this.state.player.actorId ? this.world.player.model : undefined);
      const color = model?.humanoid?.top ?? model?.colors?.primary;
      return { actor: { ...view, id: a.id, ...(color ? { color } : {}) }, tile: null };
    }
    return { actor: null, tile: this.tileInfo(pos, seen === 2) };
  }

  private tileInfo(pos: Pos, visible: boolean): TileTooltipView {
    const map = this.state.area.map;
    const t = map.tiles[pos.y * map.width + pos.x];
    const plan = this.world.areas[this.state.area.index];
    let title: string;
    let description: string | undefined;
    const terr = t?.terrain ? this.world.terrains.find((x) => x.id === t.terrain) : undefined;
    if (terr) {
      title = terr.name;
      description = terr.description;
    } else {
      switch (t?.kind) {
        case 'wall':
          title = 'Wall';
          break;
        case 'door':
          title = 'Door (closed)';
          break;
        case 'door_open':
          title = 'Door (open)';
          break;
        case 'water':
          title = 'Water';
          break;
        case 'void':
          title = 'Void';
          break;
        case 'transition':
          title = plan?.transitionName ?? 'Exit';
          description = 'Stand here and press > to move on.';
          break;
        default:
          title = plan?.name ?? 'Ground';
      }
    }
    if (!visible) description = description ? `${description} (remembered)` : '(remembered)';
    const items = visible
      ? this.state.area.items.filter((fi) => fi.pos.x === pos.x && fi.pos.y === pos.y).map((fi) => {
          const v = describeItemDef(this.state, fi.item.defId);
          return fi.item.count > 1 ? `${v.name} ×${fi.item.count}` : v.name;
        })
      : [];
    return { title, ...(description ? { description } : {}), ...(items.length ? { items } : {}) };
  }

  // ---------------------------------------------------------------------------
  // engine actions
  // ---------------------------------------------------------------------------

  /** run one engine action and keep the controller-side state consistent with the result */
  act(action: PlayerAction): Outcome {
    const out = emptyOutcome();
    const before = this.state;
    const res = step(before, action);
    for (const e of res.events) if (e.type === 'invalid') out.toasts.push({ text: explainInvalid(this.world, before, action, e.reason), tone: 'warn' });
    out.events = res.events;
    if (res.state === before) return out;
    out.changed = true;
    // the player has started acting: narration from before this action has been read (or
    // skipped) and must not stay over the board (issues/M1-narration-covers-player.md); a card
    // this action opens (a new area) stays until the next action
    this.narration = null;
    const prevChoice = before.pendingChoice;
    this.state = res.state;
    const pc = this.state.pendingChoice;

    // dialogue history: the NPC line + the player's reply, for the conversation just answered
    if (action.type === 'choose_option' && prevChoice?.kind === 'dialogue') {
      const label = prevChoice.options[action.index]?.label ?? '';
      this.pushHistory({ who: 'npc', text: prevChoice.prompt }, { who: 'player', text: label });
    }
    if (pc?.kind !== 'dialogue') this.tradeOpen = false;
    else if (action.type !== 'choose_option' && prevChoice?.kind !== 'dialogue') this.history = []; // a new conversation

    if (this.state.area.index !== before.area.index) {
      out.areaChanged = true;
      this.cancelCursor();
      this.travelDest = null;
      const plan = this.world.areas[this.state.area.index];
      if (plan) this.narration = { id: `area-${this.state.area.index}-${++this.narrationSeq}`, kind: 'area_enter', title: plan.name, text: plan.description };
    }
    if (this.ended) {
      this.cancelCursor();
      this.travelDest = null;
      this.tradeOpen = false;
    }
    return out;
  }

  private pushHistory(...lines: { who: 'npc' | 'player'; text: string }[]): void {
    this.history = [...this.history, ...lines.filter((l) => l.text)].slice(-HISTORY_LIMIT);
  }

  /** an engine action from the UI: movement keys are screen-relative, so they follow the camera */
  uiAction(action: PlayerAction): Outcome {
    this.travelDest = null;
    if (action.type === 'move') return this.act({ type: 'move', dir: rotateDir(action.dir, this.cameraStep) });
    if (action.type === 'use' && action.target === undefined) {
      // aimed items always go through targeting, even when activated from a menu
      const it = this.state.player.slots[action.slot];
      const def = it ? this.world.items.find((d) => d.id === it.defId) : undefined;
      if (def && needsTarget(def)) return this.beginTarget(action.slot);
    }
    return this.act(action);
  }

  // ---------------------------------------------------------------------------
  // UI intents
  // ---------------------------------------------------------------------------

  intent(i: UiIntent): Outcome {
    switch (i.type) {
      case 'rotate_camera':
        return { ...emptyOutcome(), camera: { rotate: i.dir } };
      case 'zoom':
        return { ...emptyOutcome(), camera: { zoom: i.delta } };
      case 'talk':
        return this.talk('talk');
      case 'persuade':
        return this.talk('persuade', i.targetId);
      case 'look':
        if (!i.on) {
          this.cancelCursor();
          return { ...emptyOutcome(), describe: null };
        }
        this.travelDest = null;
        this.mode = 'look';
        this.targetingSlot = undefined;
        this.cursor = { ...this.player().pos };
        return { ...emptyOutcome(), describe: { pos: this.cursor, ...this.describeAt(this.cursor) } };
      case 'begin_target':
        return this.beginTarget(i.slot);
      case 'look_move':
      case 'target_move':
        return this.moveCursor(i.dir);
      case 'confirm_cursor':
        return this.confirmCursor();
      case 'cancel':
        this.cancelCursor();
        return { ...emptyOutcome(), describe: null };
      case 'click_tile':
        return this.click(i.pos, i.button);
      case 'hover_tile':
        return this.hover(i.pos);
      case 'open_trade':
        this.tradeOpen = true;
        return emptyOutcome();
      case 'panel':
        if (i.open) this.travelDest = null;
        return emptyOutcome();
      default:
        return emptyOutcome();
    }
  }

  /** talk/persuade with the nearest NPC the engine accepts (or the given one) */
  private talk(kind: 'talk' | 'persuade', targetId?: string): Outcome {
    this.travelDest = null;
    let out = emptyOutcome();
    // persuading from the dialogue panel: leave the conversation first (the engine accepts no
    // other action while a choice is open)
    if (this.state.pendingChoice?.kind === 'dialogue') {
      if (kind === 'talk') return out;
      const leave = dialogueMap(this.state.pendingChoice).leaveIndex;
      const speaker = this.state.pendingChoice.speakerId;
      if (leave === null) return { ...out, toasts: [{ text: 'finish the conversation first', tone: 'warn' }] };
      out = this.act({ type: 'choose_option', index: leave });
      targetId = targetId ?? speaker;
    }
    let id = targetId;
    if (!id) {
      const p = this.player().pos;
      const cands = legalActions(this.state)
        .filter((a): a is { type: 'talk' | 'persuade'; targetId: string } => a.type === kind)
        .map((a) => this.state.area.actors.find((x) => x.id === a.targetId)!)
        .filter(Boolean)
        .sort((a, b) => cheb(a.pos, p) - cheb(b.pos, p) || a.id.localeCompare(b.id));
      // prefer whoever the look cursor is on
      const looked = this.cursor ? cands.find((a) => a.pos.x === this.cursor!.x && a.pos.y === this.cursor!.y) : undefined;
      id = (looked ?? cands[0])?.id;
    }
    if (!id) {
      const what = kind === 'talk' ? 'talk to' : 'persuade';
      return merge(out, { ...emptyOutcome(), toasts: [{ text: `There is no one nearby to ${what}.`, tone: 'warn' }] });
    }
    return merge(out, this.act({ type: kind, targetId: id }));
  }

  private beginTarget(slot: number): Outcome {
    this.travelDest = null;
    const it = this.state.player.slots[slot];
    if (!it) return { ...emptyOutcome(), toasts: [{ text: 'That slot is empty.', tone: 'warn' }] };
    this.mode = 'target';
    this.targetingSlot = slot;
    // start on the engine's automatic target (nearest sensible foe in range), else on the player
    const auto = legalActions(this.state).find((a): a is { type: 'use'; slot: number; target?: Pos } => a.type === 'use' && a.slot === slot);
    this.cursor = auto?.target ? { ...auto.target } : { ...this.player().pos };
    return { ...emptyOutcome(), describe: { pos: this.cursor, ...this.describeAt(this.cursor) } };
  }

  private moveCursor(dir: Dir): Outcome {
    if (this.mode === 'normal' || !this.cursor) return emptyOutcome();
    const d = DELTA[rotateDir(dir, this.cameraStep)];
    const next = { x: this.cursor.x + d[0], y: this.cursor.y + d[1] };
    if (this.inBounds(next)) this.cursor = next;
    return { ...emptyOutcome(), describe: { pos: this.cursor, ...this.describeAt(this.cursor) } };
  }

  private confirmCursor(): Outcome {
    if (!this.cursor) return emptyOutcome();
    if (this.mode === 'look') return { ...emptyOutcome(), describe: { pos: this.cursor, ...this.describeAt(this.cursor) } };
    if (this.mode === 'target' && this.targetingSlot !== undefined) {
      const slot = this.targetingSlot;
      const target = { ...this.cursor };
      const out = this.act({ type: 'use', slot, target });
      // an invalid target (out of range, no line of sight) keeps targeting open so the player can fix it
      if (out.changed) this.cancelCursor();
      return { ...out, describe: out.changed ? null : undefined };
    }
    return emptyOutcome();
  }

  cancelCursor(): void {
    this.mode = 'normal';
    this.cursor = null;
    this.targetingSlot = undefined;
  }

  private click(pos: Pos, button: 'primary' | 'secondary'): Outcome {
    if (button === 'secondary') {
      if (this.mode === 'target') {
        this.cancelCursor();
        return { ...emptyOutcome(), describe: null };
      }
      return { ...emptyOutcome(), describe: { pos, ...this.describeAt(pos) } };
    }
    if (this.mode === 'target') {
      this.cursor = { ...pos };
      return this.confirmCursor();
    }
    if (this.mode === 'look') {
      this.cursor = { ...pos };
      return { ...emptyOutcome(), describe: { pos, ...this.describeAt(pos) } };
    }
    if (this.state.pendingChoice || this.state.player.pendingPerkChoice || this.ended) return emptyOutcome();
    const p = this.player().pos;
    if (p.x === pos.x && p.y === pos.y) {
      // clicking yourself picks up what lies here, or takes the exit when standing on it
      if (this.state.area.items.some((fi) => fi.pos.x === p.x && fi.pos.y === p.y)) return this.act({ type: 'pickup' });
      if (legalActions(this.state).some((a) => a.type === 'transition')) return this.act({ type: 'transition' });
      return emptyOutcome();
    }
    // a visible hostile in weapon range (but not adjacent): shoot it
    const target = actorAt(this.state, pos);
    if (target && cheb(target.pos, p) > 1 && this.seenAt(pos) === 2) {
      const atk = legalActions(this.state).find((a) => a.type === 'attack' && a.targetId === target.id);
      if (atk) return this.act(atk);
    }
    if (!travelStep(this.state, pos)) return { ...emptyOutcome(), toasts: [{ text: 'No known way there.', tone: 'info' }] };
    this.travelDest = { ...pos };
    this.travelSeen = visibleHostiles(this.state);
    return { ...emptyOutcome(), travel: true };
  }

  private hover(pos: Pos | null): Outcome {
    if (!pos) return { ...emptyOutcome(), describe: null };
    if (this.mode === 'target' || this.mode === 'look') {
      if (this.inBounds(pos)) this.cursor = { ...pos };
    }
    const d = this.describeAt(pos);
    if (!d.actor && !d.tile) return { ...emptyOutcome(), describe: null };
    // terrain tooltips only in look/target mode; actors and items always
    if (!d.actor && this.mode === 'normal' && !d.tile?.items?.length) return { ...emptyOutcome(), describe: null };
    return { ...emptyOutcome(), describe: { pos, ...d } };
  }

  /**
   * One click-to-travel step. Returns the outcome and whether travel goes on. Travel stops when the
   * destination is reached, the route is gone, a new hostile comes into view, the player gets hurt,
   * a choice/level-up/narration-worthy event happens or the area changes.
   */
  travelTick(): { outcome: Outcome; more: boolean } {
    const dest = this.travelDest;
    if (!dest || this.ended || this.state.pendingChoice || this.state.player.pendingPerkChoice || this.mode !== 'normal') {
      this.travelDest = null;
      return { outcome: emptyOutcome(), more: false };
    }
    const dir = travelStep(this.state, dest);
    if (!dir) {
      this.travelDest = null;
      return { outcome: emptyOutcome(), more: false };
    }
    const hpBefore = this.player().hp;
    const out = this.act({ type: 'move', dir });
    if (!out.changed || this.ended || out.areaChanged) {
      this.travelDest = null;
      return { outcome: out, more: false };
    }
    const now = visibleHostiles(this.state);
    const fresh = [...now].some((id) => !this.travelSeen.has(id));
    this.travelSeen = now;
    const p = this.player();
    const arrived = p.pos.x === dest.x && p.pos.y === dest.y;
    // steady ambient drains (world rules, standing in a hazard for a step) don't stop travel; being
    // hit by someone, dropping to low health or anything that needs a decision does
    const pid = this.state.player.actorId;
    const interrupted =
      fresh ||
      !!this.state.pendingChoice ||
      !!this.state.player.pendingPerkChoice ||
      out.events.some(
        (e) =>
          (e.type === 'attacked' && (e.targetId === pid || e.attackerId === pid)) ||
          (e.type === 'damaged' && e.actorId === pid && !!e.sourceId && e.sourceId !== pid) ||
          (e.type === 'status_applied' && e.actorId === pid) ||
          e.type === 'low_hp' ||
          e.type === 'level_up' ||
          e.type === 'item_picked' ||
          e.type === 'region_discovered' ||
          e.type === 'spawned',
      ) ||
      p.hp < hpBefore - Math.max(2, Math.ceil(p.maxHp * 0.1));
    if (arrived || interrupted) {
      this.travelDest = null;
      return { outcome: out, more: false };
    }
    return { outcome: out, more: true };
  }

  stopTravel(): void {
    this.travelDest = null;
  }

  // ---------------------------------------------------------------------------
  // dialogue, trade, narration
  // ---------------------------------------------------------------------------

  dialogueReply(index: number): Outcome {
    const pc = this.state.pendingChoice;
    if (!pc || pc.kind !== 'dialogue') return emptyOutcome();
    const m = dialogueMap(pc);
    const engineIndex = m.engineIndex[index];
    if (engineIndex === undefined) return emptyOutcome();
    return this.act({ type: 'choose_option', index: engineIndex });
  }

  dialogueLeave(): Outcome {
    const pc = this.state.pendingChoice;
    if (!pc || pc.kind !== 'dialogue') return emptyOutcome();
    const m = dialogueMap(pc);
    // every engine dialogue ends with a no-op "goodbye"; fall back to the last no-op option
    let idx = m.leaveIndex;
    if (idx === null) {
      for (let i = pc.options.length - 1; i >= 0; i--) if (pc.options[i].actions.length === 0 && !pc.options[i].tag) { idx = i; break; }
    }
    if (idx === null) return { ...emptyOutcome(), toasts: [{ text: 'Pick one of the replies.', tone: 'warn' }] };
    return this.act({ type: 'choose_option', index: idx });
  }

  trade(t: TradeIntent): Outcome {
    if (t.type === 'close') {
      this.tradeOpen = false;
      return emptyOutcome();
    }
    if (t.type === 'sell') return { ...emptyOutcome(), toasts: [{ text: 'This trader is not buying.', tone: 'info' }] };
    const pc = this.state.pendingChoice;
    if (!pc || pc.kind !== 'dialogue') return emptyOutcome();
    const m = dialogueMap(pc);
    const idx = m.buy[t.offerIndex];
    if (idx === undefined) return emptyOutcome();
    const speaker = pc.speakerId;
    const out = this.act({ type: 'choose_option', index: idx });
    if (!out.changed || !speaker || this.state.pendingChoice) return out;
    // buying resolves the engine's choice; reopen the conversation so the shop stays open
    const history = this.history;
    const again = this.act({ type: 'talk', targetId: speaker });
    const reopened = this.state.pendingChoice as PendingChoice | null; // (TS narrowed it to null above)
    if (again.changed && reopened?.kind === 'dialogue') {
      this.history = history;
      this.tradeOpen = dialogueMap(reopened).buy.length > 0;
    }
    // the reopen is bookkeeping: its refusal (if any) is not news to the player
    return merge(out, { ...again, toasts: [] });
  }

  dismissNarration(id: string): void {
    if (this.narration && this.narration.id === id) this.narration = null;
  }

  setCameraStep(step: number): void {
    this.cameraStep = ((step % 4) + 4) % 4;
  }
}
