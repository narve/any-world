/**
 * RoomSession (MP3 design §1.1–§1.3, §3.4): the GameSession of a room. The room's replica is kept by
 * RoomClient (lockstep, hashed); this session never steps the engine for real and never writes the
 * replica. Its `state` is the replica's perspective for this player (perspective.ts), assigned in
 * `absorb` and `rebuild` only, so every existing read of `state` (view, travel, guide, legal
 * actions, audio cues) answers for this player.
 *
 * An action from the UI is dry-run on the raw replica (stepTurn with this player's input: party
 * order changes engine results) and sent as an `input`: an illegal one toasts as in single player
 * and is not sent, a down player sends nothing, a not-ready one is sent and shown as queued. The dry
 * run is skipped for `transition` and the last exit-countdown turn, which make the next area. One
 * turn action is sent per turn (the same one again is not resent; another replaces it). The chains
 * single player builds from several act calls (an answered dialogue reply, a buy or sell, leave
 * then persuade) go as one input; their bookkeeping (history kept, the answer as the NPC's line,
 * the shop kept open) happens when their entry arrives. Click-to-travel sends one step per turn
 * from the entries instead of a timer.
 *
 * The entries come from RoomClient's `entries` event one step each: turn entries go through
 * absorbStep (this player's outcome as `mine`), gm entries through absorbGm (intro, area and event
 * cards from the server's GM), join / away / back / leave / return give the party toasts. A catch-up
 * batch (a reconnect) rebuilds without toasts or narration cards.
 *
 * MP4: NPC lines of the teammates' conversations and the GM's `say` lines become bubbles over the NPC
 * (npcBubbles); the server's `npc` voice line for this player's conversation turn stands in for the
 * canned prompt, as single player's voice does.
 *
 * DOM-free: the browser's RoomLink (D3) owns the client and applies the outcomes.
 */
import type { GmAction, GmHook } from '../../schema/gm';
import type { GameState, LogMessage, PlayerAction, PlayerId, Pos, TurnOutcome } from '../../engine/types';
import { stepTurn } from '../../engine/index';
import { FREE_ACTIONS } from '../../engine/party';
import type { EntryStep, RoomClient } from '../../net/client';
import type { Intent, ServerMsg } from '../../net/protocol';
import { emptyOutcome, GameSession, merge, type Outcome, type ReplyPlan, type Toast } from '../session';
import { dialogueMap } from '../view';
import type { TradeIntent, UiViewModel } from '../ui/viewmodel';
import { explainInvalid } from '../invalid';
import { t as tr } from '../i18n/index';
import { perspective } from './perspective';
import { LogOverlay } from './log-overlay';
import { NpcBubbles } from './npc-bubbles';
import { voiceMoment } from '../../gm/voice';

/** a chain sent as one input, waiting for its entry (its bookkeeping happens on absorb) */
type PendingChain =
  | { kind: 'reply'; actions: PlayerAction[]; plan: ReplyPlan }
  | { kind: 'trade'; actions: PlayerAction[]; voice: { voice: { token: number; line: string } | null; token: number } };

/** the turn action sent for the current turn (the HUD marks it as queued) */
export interface Queued {
  action: PlayerAction;
  area: number;
  turn: number;
  intent: Intent;
}

export interface RoomSessionInit {
  /** a joined client in the playing phase (state, world and pid set) */
  client: RoomClient;
  prefs?: { animationSpeed: number; reduceMotion: boolean };
  /** the clock of the NPC bubbles (default Date.now) */
  now?: () => number;
}

const key = (a: PlayerAction) => JSON.stringify(a);

function sameActions(a: readonly PlayerAction[] | undefined, b: readonly PlayerAction[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => key(x) === key(b[i]));
}

export class RoomSession extends GameSession {
  readonly client: RoomClient;
  /** the room's run this session plays (a new run gets a new session) */
  readonly run: number;
  /** client-only log lines (the healer's line), merged into the log view */
  readonly overlay = new LogOverlay();
  /** NPC lines over the NPC for nearby teammates (MP4 design §4.2): the party overlay draws `visible` */
  readonly npcBubbles = new NpcBubbles();
  private readonly now: () => number;
  /** the entry of this player's current conversation turn (voiceMoment): the server's `npc` line for it is the NPC's voice */
  private voiceN: number | null = null;
  /** the turn action waiting for its turn */
  queued: Queued | null = null;
  /** the teammate the camera follows while this player is down (null: this player) */
  followed: PlayerId | null = null;
  private chain: PendingChain | null = null;
  /** true only while absorb / rebuild assign `state` (tests trap every other write) */
  private assigning = false;
  /** hp before the travel step that is queued (its stop rules run when it resolves) */
  private travelHp: number | null = null;

  constructor(init: RoomSessionInit) {
    const c = init.client;
    if (!c.state || !c.world || !c.worldId || !c.pid) throw new Error('RoomSession needs a joined client in a running game');
    super({
      world: c.world,
      worldId: c.worldId,
      seed: c.state.seed,
      room: { state: perspective(c.state, c.pid), pid: c.pid },
      ...(c.state.difficulty ? { difficulty: c.state.difficulty } : {}),
      ...(init.prefs ? { prefs: init.prefs } : {}),
    });
    this.client = c;
    this.run = c.run;
    this.now = init.now ?? (() => Date.now());
    this.updateFollow();
  }

  /** the room's replica (RoomClient's state, the object it hashes): the dry run reads it, nothing writes it */
  get replica(): GameState {
    return this.client.state!;
  }

  /** whether `state` may be assigned right now (absorb and rebuild) */
  get writable(): boolean {
    return this.assigning;
  }

  /** what the renderer and the party overlay show: this player, or the followed teammate while down */
  override get cameraState(): GameState {
    return this.followed ? perspective(this.replica, this.followed) : this.state;
  }

  /**
   * Subscribes to the client: entries are absorbed, replica replacements rebuild the view, refusals
   * and stale errors are handled; each Outcome goes to `apply`. Another run (a `run` message, or a
   * welcome of a later run after a reconnect) is not handled here: a new run gets a new session, so
   * the owner disposes this one. Returns the unsubscribe.
   */
  attach(apply: (out: Outcome) => void): () => void {
    return this.client.on((e) => {
      if (this.client.run !== this.run) return;
      if (e.t === 'entries') apply(this.absorb(e.steps, e.catchUp));
      else if (e.t === 'state' && e.reason !== 'run') apply(this.rebuild());
      else if (e.t === 'message') {
        const out = this.onMessage(e.msg);
        if (out) apply(out);
      }
    });
  }

  /** the view model as single player builds it, with this player's own name on the HUD */
  override viewModel(extra: Partial<UiViewModel> = {}): UiViewModel {
    const vm = super.viewModel(extra);
    const name = this.me?.name;
    if (vm.game && name) vm.game = { ...vm.game, hud: { ...vm.game.hud, playerName: name } };
    return vm;
  }

  protected override readonly interactHintKey = 'ctx.interactHintRoom' as const;

  protected override clientLog(): LogMessage[] {
    return this.overlay.merge(this.gmLog);
  }

  // ---------------------------------------------------------------------------
  // sending
  // ---------------------------------------------------------------------------

  /** a UI action: dry-run on the replica, then sent (never stepped here) */
  override act(action: PlayerAction): Outcome {
    const intent: Intent = action.type === 'wait' ? 'wait' : 'decide';
    return this.send([action], intent, { check: 'all' });
  }

  /** the GM is the server's: local GM answers and NPC voice actions are not applied in a room */
  override applyGm(): Outcome {
    return emptyOutcome();
  }

  /**
   * Sends `actions` (free actions and at most one turn action) as one input after a dry run on the
   * replica. `check`: which refusals stop it ('all', or only the first action's, for a chain whose
   * later actions are bookkeeping).
   */
  private send(actions: PlayerAction[], intent: Intent, o: { check: 'all' | 'first'; chain?: PendingChain }): Outcome {
    const out = emptyOutcome();
    this.wasteWarned = null;
    const replica = this.client.state;
    if (this.client.status !== 'joined' || !replica) return { ...out, toasts: [{ text: tr('room.offline'), tone: 'warn' }] };
    if (replica.status !== 'playing' || !actions.length) return out;
    const turnAct = actions.find((a) => !FREE_ACTIONS.has(a.type));
    const area = replica.area.index;
    // the same turn action again for this turn (key repeat) is not resent
    const q = this.queued;
    if (turnAct && actions.length === 1 && q && q.turn === replica.turn && q.area === area && key(q.action) === key(turnAct)) return { ...out, pending: turnAct };
    if (!this.skipDryRun(replica, actions)) {
      const r = stepTurn(replica, [{ playerId: this.pid, actions }], { world: this.world });
      const mine = r.outcomes.filter((x) => x.playerId === this.pid);
      const checked = o.check === 'all' ? mine : mine.slice(0, 1);
      const illegal = checked.find((x) => !x.ok && x.reason === 'illegal');
      if (illegal) return { ...out, toasts: [this.invalidToast(illegal)] };
      // the down card says why nothing happens
      if (checked.some((x) => !x.ok && x.reason === 'down')) return out;
    }
    if (!this.client.input(actions, intent)) return { ...out, toasts: [{ text: tr('room.offline'), tone: 'warn' }] };
    if (turnAct) this.queued = { action: turnAct, area, turn: replica.turn, intent };
    this.chain = o.chain ?? null;
    return { ...out, pending: turnAct ?? actions[actions.length - 1] };
  }

  /** a transition, or any action on the last exit-countdown turn, makes the next area: not dry-run on the main thread */
  private skipDryRun(replica: GameState, actions: PlayerAction[]): boolean {
    const cd = replica.area.exitCountdown;
    return actions.some((a) => a.type === 'transition') || (!!cd && cd.turnsLeft <= 1);
  }

  private invalidToast(o: { action: PlayerAction; detail?: string; reason?: string }): Toast {
    return { text: explainInvalid(this.world, this.state, o.action, o.detail ?? o.reason ?? ''), tone: 'warn' };
  }

  override dialogueReply(index: number): Outcome {
    const plan = this.replyPlan(index);
    if (!plan) return emptyOutcome();
    const actions = this.dialogueReplyActions(index);
    return this.send(actions, 'decide', { check: 'first', ...(actions.length > 1 ? { chain: { kind: 'reply', actions, plan } } : {}) });
  }

  override trade(t: TradeIntent): Outcome {
    if (t.type === 'close') return super.trade(t);
    const plan = this.tradePlan(t);
    if (!plan) return emptyOutcome();
    if ('toast' in plan) return { ...emptyOutcome(), toasts: [plan.toast] };
    const actions = this.tradeActions(t);
    const voice = { voice: this.voice, token: this.voiceToken };
    return this.send(actions, 'decide', { check: 'first', ...(actions.length > 1 ? { chain: { kind: 'trade', actions, voice } } : {}) });
  }

  /** persuading from the dialogue panel: leave and persuade as one input */
  protected override talk(kind: 'talk' | 'persuade', targetId?: string): Outcome {
    const pc = this.me.pendingChoice;
    if (kind !== 'persuade' || pc?.kind !== 'dialogue') return super.talk(kind, targetId);
    this.travelDest = null;
    const leave = dialogueMap(pc).leaveIndex;
    if (leave === null) return { ...emptyOutcome(), toasts: [{ text: tr('toast.finishConversation'), tone: 'warn' }] };
    const id = targetId ?? pc.speakerId;
    if (!id) return emptyOutcome();
    return this.send([{ type: 'choose_option', index: leave }, { type: 'persuade', targetId: id }], 'decide', { check: 'all' });
  }

  /** the first click-to-travel step; the next ones are sent from the entries, one per turn */
  override travelTick(): { outcome: Outcome; more: boolean } {
    const out = this.sendTravel();
    return { outcome: out ?? emptyOutcome(), more: false };
  }

  private sendTravel(): Outcome | null {
    const a = this.nextTravelAction();
    if (!a) return null;
    const hp = this.player().hp;
    const out = this.send([a], 'travel', { check: 'all' });
    if (!out.pending) {
      this.travelDest = null;
      this.travelHp = null;
    } else this.travelHp = hp;
    return out;
  }

  override stopTravel(): void {
    super.stopTravel();
    this.travelHp = null;
  }

  // ---------------------------------------------------------------------------
  // receiving
  // ---------------------------------------------------------------------------

  /** assigns the view state (absorb and rebuild only) */
  private view(s: GameState): void {
    this.assigning = true;
    try {
      this.state = perspective(s, this.pid);
    } finally {
      this.assigning = false;
    }
  }

  /**
   * Applied entries, one step each (RoomClient's `entries` event). Returns one Outcome for the batch;
   * a catch-up batch (`catchUp`: a reconnect's welcome entries) gives no toasts and no new narration card.
   */
  absorb(steps: readonly EntryStep[], catchUp = false): Outcome {
    let out = emptyOutcome();
    const card = this.narration;
    const area = this.state.area.index;
    this.assigning = true;
    try {
      for (const st of steps) out = merge(out, this.absorbEntry(st, catchUp));
      // (the last step's after is the replica)
      if (steps.length) this.state = perspective(this.replica, this.pid);
    } finally {
      this.assigning = false;
    }
    if (this.queued && (this.replica.area.index !== this.queued.area || this.ended)) this.queued = null;
    if (this.ended) this.chain = null;
    // (a choice the batch opened, a GM offer say, ends the walk as in single player)
    if (this.travelDest && (this.me.pendingChoice || this.me.pendingPerkChoice)) this.stopTravel();
    // the next travel step once the last one resolved (a player short of energy sends it too: the
    // server keeps it pending while the world moves on)
    if (this.travelDest && !this.queued && !this.ended) {
      const next = this.sendTravel();
      if (next) out = merge(out, next);
    } else if (!this.travelDest) this.travelHp = null;
    this.updateFollow();
    if (catchUp) {
      out.toasts = [];
      this.narration = this.state.area.index === area ? card : null;
    }
    return out;
  }

  private absorbEntry(st: EntryStep, catchUp: boolean): Outcome {
    const e = st.entry;
    const before = perspective(st.before, this.pid);
    const after = perspective(st.after, this.pid);
    // (a catch-up repeats nothing: its lines are old)
    if (catchUp) this.npcBubbles.clear();
    else {
      const now = this.now();
      this.npcBubbles.observe(st.before, st.after, this.pid, now);
      if (e.k === 'gm') this.npcBubbles.gm(e.actions as GmAction[], st.after, now);
    }
    switch (e.k) {
      case 'turn':
        return this.absorbTurn(st, before, after, e.inputs.find((i) => i.playerId === this.pid)?.actions);
      case 'gm':
        return this.absorbGm(before, after, st.events, e.actions as GmAction[], { hook: e.hook as GmHook, area: after.area.index });
      default: {
        this.state = after;
        const out: Outcome = { ...emptyOutcome(), changed: true, events: st.events, areaChanged: before.area.index !== after.area.index };
        if (catchUp || e.pid === this.pid) return out;
        const name = e.k === 'join' ? e.name : (after.players[e.pid]?.name ?? tr('common.someone'));
        const k = e.k === 'join' ? 'party.joined' : e.k === 'away' ? 'party.away' : e.k === 'leave' ? 'party.left' : 'party.back';
        out.toasts.push({ text: tr(k, { name }), tone: 'info' });
        return out;
      }
    }
  }

  private absorbTurn(st: EntryStep, before: GameState, after: GameState, myActions: PlayerAction[] | undefined): Outcome {
    const mine = st.outcomes.filter((o) => o.playerId === this.pid);
    // (the same rule as the server's: a new conversation turn waits for its voice line)
    if (voiceMoment(st.before, st.after, this.pid, myActions, st.outcomes)) this.voiceN = st.entry.n;
    else if (after.players[this.pid]?.pendingChoice?.kind !== 'dialogue') this.voiceN = null;
    const chain = this.chain && sameActions(myActions, this.chain.actions) ? this.chain : null;
    if (chain) this.chain = null;
    const q = this.queued;
    const resolved = q ? mine.find((o) => key(o.action) === key(q.action) && (o.ok || o.reason !== 'not ready')) : undefined;
    if (resolved) this.queued = null;
    const hpBefore = this.hpOf(before);
    const main = mine.find((o) => o.ok);
    const out = this.absorbStep(before, after, st.events, main ? { action: main.action, tookTurn: main.tookTurn } : undefined);
    if (chain) this.chainDone(chain, mine, hpBefore);
    // a travel step resolved: the single-player stop rules decide whether the walk goes on
    if (resolved && q?.intent === 'travel' && this.travelDest) {
      if (!resolved.ok) this.travelDest = null;
      else this.travelGoesOn(out, this.travelHp ?? hpBefore);
      this.travelHp = null;
    }
    return out;
  }

  /** the bookkeeping of a chain whose entry arrived (single player does it after its act calls) */
  private chainDone(chain: PendingChain, mine: TurnOutcome[], hpBefore: number): void {
    if (!mine[0]?.ok) return;
    const pc = this.me.pendingChoice;
    const reopened = mine.length > 1 && mine[1].ok && pc?.kind === 'dialogue' ? pc : null;
    if (chain.kind === 'reply') {
      // (the greeting of the reopen stays in the shared log; the healer's line is this client's)
      const { answer, extraLog } = this.replyAnswer(chain.plan, Math.max(0, this.hpOf(this.state) - hpBefore));
      if (extraLog) this.overlay.add(extraLog);
      if (!reopened) return;
      this.tradeOpen = false;
      this.keepConversation(reopened, this.history, answer, chain.plan.label);
    } else if (reopened) this.keepShop(reopened, this.history, chain.voice);
  }

  private hpOf(s: GameState): number {
    const id = s.players[this.pid]?.actorId;
    return s.area.actors.find((a) => a.id === id)?.hp ?? 0;
  }

  /** the replica was replaced (a welcome or desync snapshot): the view is rebuilt, nothing in flight is kept */
  rebuild(): Outcome {
    this.view(this.replica);
    this.npcBubbles.clear();
    this.voiceN = null;
    this.narration = null;
    this.queued = null;
    this.chain = null;
    this.stopTravel();
    this.cancelCursor();
    this.tradeOpen = this.tradeOpen && this.me.pendingChoice?.kind === 'dialogue';
    // rules that changed meanwhile are taken as they are, without toasts
    this.rules.update(this.world, this.state);
    this.updateFollow();
    return { ...emptyOutcome(), changed: true, areaChanged: true };
  }

  /**
   * The NPC voice (MP4 design §4.3): a line for this player's conversation on its current turn stands
   * in for the canned prompt (single player's voice line); a teammate's is a bubble over the NPC while
   * that conversation is open. Words only.
   */
  private onVoice(msg: Extract<ServerMsg, { t: 'npc' }>): Outcome | null {
    if (msg.run !== this.run || this.ended) return null;
    if (msg.pid === this.pid) {
      const pc = this.me.pendingChoice;
      if (msg.n !== this.voiceN || pc?.kind !== 'dialogue' || pc.speakerId !== msg.actorId) return null;
      this.voice = { token: this.voiceToken, line: msg.text.trim() };
      return { ...emptyOutcome(), changed: true };
    }
    const pc = this.replica.players[msg.pid]?.pendingChoice;
    if (pc?.kind === 'dialogue' && pc.speakerId === msg.actorId) this.npcBubbles.set(msg.actorId, msg.text, this.now());
    return null;
  }

  /** refusals (to this seat) toast as in single player; a stale (or rate-dropped) input is decided again */
  onMessage(msg: ServerMsg): Outcome | null {
    if (msg.t === 'npc') return this.onVoice(msg);
    if (msg.t === 'refusal') {
      const q = this.queued;
      const mine = q ? msg.reasons.find((r) => key(r.action) === key(q.action)) : undefined;
      // a refused travel step ends the walk quietly (something came up: single player stops there too)
      const travel = !!mine && q!.intent === 'travel';
      if (travel) this.stopTravel();
      const toasts = msg.reasons.filter((r) => r.reason === 'illegal' && !(travel && r === mine)).map((r) => this.invalidToast(r));
      if (mine) this.queued = null;
      if (this.chain && msg.reasons.some((r) => this.chain!.actions.some((a) => key(a) === key(r.action)))) this.chain = null;
      return toasts.length ? { ...emptyOutcome(), toasts } : null;
    }
    // (an input the socket's message bucket dropped never reached the room: decided again, as a stale one)
    if (msg.t === 'error' && (msg.code === 'stale' || msg.code === 'rate')) {
      this.queued = null;
      this.chain = null;
      if (!this.travelDest) return null;
      return this.sendTravel();
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // spectator camera (§3.4)
  // ---------------------------------------------------------------------------

  /** teammates standing on the map, in party order */
  standingTeammates(): PlayerId[] {
    const s = this.replica;
    return s.party.filter((id) => id !== this.pid && !s.players[id]?.down && !s.players[id]?.left);
  }

  /** while down: keep the followed teammate until they go down or leave, else the nearest standing one (straight distance) */
  private updateFollow(): void {
    if (!this.me?.down || this.ended) {
      this.followed = null;
      return;
    }
    const standing = this.standingTeammates();
    if (this.followed && standing.includes(this.followed)) return;
    const me = this.posOf(this.pid);
    let best: PlayerId | null = null;
    let bestD = Infinity;
    for (const id of standing) {
      const p = this.posOf(id);
      if (!me || !p) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d < bestD) [best, bestD] = [id, d];
    }
    this.followed = best;
  }

  /** `[` / `]` and the spectator pill: the previous or next standing teammate (while down) */
  cycleFollow(dir: -1 | 1): PlayerId | null {
    const standing = this.standingTeammates();
    if (!this.me.down || !standing.length) return this.followed;
    const i = this.followed ? standing.indexOf(this.followed) : -1;
    this.followed = standing[(((i + dir) % standing.length) + standing.length) % standing.length];
    return this.followed;
  }

  /** a party chip tapped while down: watch that teammate (a standing one); returns who is followed */
  follow(pid: PlayerId): PlayerId | null {
    if (this.me.down && this.standingTeammates().includes(pid)) this.followed = pid;
    return this.followed;
  }

  private posOf(pid: PlayerId): Pos | null {
    const s = this.replica;
    const id = s.players[pid]?.actorId;
    return s.area.actors.find((a) => a.id === id)?.pos ?? null;
  }
}
