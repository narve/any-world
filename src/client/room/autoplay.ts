/**
 * In-page autoplay for the exit check (MP3 design §7, e2e-mp/mp-exit.spec.ts): a sim bot plays this
 * page's player through the real path, `controller.actNow` → `RoomSession.act` (dry run, input,
 * queued), so every action goes UI → protocol as a key press would. It decides on the raw replica
 * for this page's pid, as the scripted clients do (tools/rooms/scripted-client.ts): one turn action
 * per ready turn, free actions (talk, choices) one at a time after the previous one's entry, an open
 * choice answered first, a locally refused action (held in place, say) replaced by a wait, and a
 * watchdog that decides again when nothing moved for a second. A chat line about every `chatEvery`
 * entries goes through the chat panel's path (typing first, then the line).
 *
 * Dev and test builds only: flow.ts imports this module behind `__ANYWORLD_AUTOPLAY__`, so the
 * production and Pages builds never contain it (nor the sim bots).
 */
import type { GameState, PlayerAction } from '../../engine/types';
import { hashState, readyPlayers } from '../../engine/index';
import { FREE_ACTIONS } from '../../engine/party';
import { botByName, newMemory, type Bot, type BotMemory, type BotName } from '../../engine/sim/bots';
import { MAX_FREE_PER_TURN } from '../../engine/sim/party';
import type { RoomClient, RoomEvent } from '../../net/client';
import type { GameController } from '../game-controller';
import type { Outcome } from '../session';
import type { RoomSession } from './room-session';

export interface AutoplayOptions {
  /** the sim bot (default explorer) */
  bot?: BotName;
  /** bot memory seed */
  seed?: number;
  /** a chat line about every this many entries (0: none; default 40) */
  chatEvery?: number;
}

export interface AutoplayHost {
  readonly client: RoomClient;
  /** the run's session and its controller while the run is on screen (null before, between runs) */
  live(): { session: RoomSession; controller: GameController } | null;
  /** a chat line through the chat panel's path (typing first); false when it could not go */
  say(text: string): boolean;
}

/** an area change seen in the entries: the replica's hash right after it (the pages compare them) */
export interface AreaMark {
  area: number;
  n: number;
  hash: string;
}

export interface AutoplayStats {
  on: boolean;
  /** turn and free actions handed to the session */
  sent: number;
  /** actions the session refused locally (replaced by a wait) */
  refused: number;
  /** refusals from the server (a teammate got there first, a choice closed meanwhile…) */
  serverRefused: number;
  said: number;
  /** the locally refused actions: `type: toast` → count */
  refusals: Record<string, number>;
  areas: AreaMark[];
  faults: string[];
}

const WATCHDOG_MS = 1000;

export class Autoplay {
  private readonly bot: Bot;
  private readonly mem: BotMemory;
  private readonly chatEvery: number;
  private readonly stats: AutoplayStats = { on: false, sent: 0, refused: 0, serverRefused: 0, said: 0, refusals: {}, areas: [], faults: [] };
  private off: (() => void) | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private thinkQueued = false;
  private turnKey = '';
  private turnSent = false;
  private freeThisTurn = 0;
  /** when the last free action was sent (cleared by its entry, a refusal, an error, or the watchdog after a while) */
  private outstanding: number | null = null;
  private watchN = -1;
  private chatBucket = 0;

  constructor(
    private readonly host: AutoplayHost,
    o: AutoplayOptions = {},
  ) {
    this.bot = botByName(o.bot ?? 'explorer');
    this.mem = newMemory(o.seed ?? 1);
    this.chatEvery = o.chatEvery ?? 40;
    // (area changes are recorded from the start, also while the bot is off)
    this.off = host.client.on((e) => this.onEvent(e));
  }

  get on(): boolean {
    return this.stats.on;
  }

  set(on: boolean): void {
    if (on === this.stats.on) return;
    this.stats.on = on;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (!on) return;
    this.chatBucket = Math.floor(this.host.client.n / Math.max(1, this.chatEvery));
    this.watchdog = setInterval(() => this.nudge(), WATCHDOG_MS);
    this.queueThink();
  }

  snapshot(): AutoplayStats {
    return { ...this.stats, refusals: { ...this.stats.refusals }, areas: this.stats.areas.slice(), faults: this.stats.faults.slice() };
  }

  dispose(): void {
    this.set(false);
    this.off?.();
    this.off = null;
  }

  private onEvent(e: RoomEvent): void {
    const pid = this.host.client.pid;
    switch (e.t) {
      case 'entries':
        for (const st of e.steps) {
          if (st.after.area.index !== st.before.area.index || st.after.status !== st.before.status) this.mark(st.entry.n + 1, st.after);
          for (const o of st.outcomes) {
            if (o.playerId !== pid) continue;
            this.mem.lastAction = o.action;
            this.mem.lastInvalid = o.ok ? null : (o.detail ?? 'refused');
            this.mem.lastReason = o.ok ? null : (o.reason ?? null);
          }
          // (only the entry with this player's own free action ends the wait: a teammate's entry
          // before it would have the bot answer the same choice twice)
          if (st.entry.k === 'turn' && st.entry.inputs.some((i) => i.playerId === pid && i.actions?.some((a) => FREE_ACTIONS.has(a.type)))) this.outstanding = null;
        }
        this.chatScript();
        break;
      case 'state':
      case 'welcome':
        this.outstanding = null;
        this.turnKey = '';
        break;
      case 'message':
        if (e.msg.t === 'refusal') {
          if (this.stats.on) this.stats.serverRefused++;
          const mine = e.msg.reasons.at(-1);
          if (mine) {
            this.mem.lastAction = mine.action;
            this.mem.lastInvalid = mine.detail ?? mine.reason;
            this.mem.lastReason = mine.reason as BotMemory['lastReason'];
          }
          // (a refused turn action is decided again; the free action in flight waits for its own answer)
          if (e.msg.reasons.some((r) => FREE_ACTIONS.has(r.action.type))) this.outstanding = null;
          if (e.msg.reasons.some((r) => !FREE_ACTIONS.has(r.action.type))) this.turnSent = false;
        } else if (e.msg.t === 'error') {
          this.outstanding = null;
          if (e.msg.code === 'stale') this.turnSent = false;
        } else return;
        break;
      default:
        return;
    }
    this.queueThink();
  }

  /** n: the room's entry count after the entry that changed the area (or ended the run) */
  private mark(n: number, s: GameState): void {
    this.stats.areas.push({ area: s.status === 'playing' ? s.area.index : -1, n, hash: hashState(s) });
  }

  private queueThink(): void {
    if (this.thinkQueued || !this.stats.on) return;
    this.thinkQueued = true;
    // (after the session absorbed the same event: its listener may come later in the list)
    setTimeout(() => {
      this.thinkQueued = false;
      try {
        this.think();
      } catch (err) {
        this.stats.faults.push(err instanceof Error ? err.message : String(err));
      }
    }, 0);
  }

  /** nothing moved since the last look: forget what was sent and decide again */
  private nudge(): void {
    const n = this.host.client.n;
    if (n === this.watchN) {
      this.outstanding = null;
      this.turnSent = false;
    }
    if (this.outstanding !== null && Date.now() - this.outstanding >= WATCHDOG_MS) this.outstanding = null;
    this.watchN = n;
    this.queueThink();
  }

  private think(): void {
    const c = this.host.client;
    const live = this.host.live();
    const s = c.state;
    const pid = c.pid;
    const world = c.world;
    if (!this.stats.on || !live || c.status !== 'joined' || c.phase !== 'playing' || !s || s.status !== 'playing' || !pid || !world) return;
    if (live.session.run !== c.run) return;
    const ps = s.players[pid];
    if (!ps || ps.down || ps.left || !s.party.includes(pid) || this.outstanding !== null) return;
    const key = `${s.area.index}:${s.turn}`;
    if (key !== this.turnKey) {
      this.turnKey = key;
      this.turnSent = false;
      this.freeThisTurn = 0;
    }
    const ready = readyPlayers(s, { world }).includes(pid);
    const choosing = !!ps.pendingChoice || !!ps.pendingPerkChoice;
    if (!choosing && (!ready || this.turnSent)) return;
    let action: PlayerAction;
    try {
      action = this.bot.decide(s, world, this.mem, pid);
    } catch (err) {
      this.stats.faults.push(`bot: ${err instanceof Error ? err.message : String(err)}`);
      action = { type: 'wait' };
    }
    if (FREE_ACTIONS.has(action.type)) {
      if (this.freeThisTurn < MAX_FREE_PER_TURN) {
        this.freeThisTurn++;
        this.outstanding = Date.now();
        if (!this.send(live.controller, action)) {
          this.outstanding = null;
          this.queueThink();
        }
        return;
      }
      if (!ready || this.turnSent) return;
      action = { type: 'wait' };
    }
    if (!ready) return;
    this.turnSent = true;
    if (!this.send(live.controller, action) && action.type !== 'wait') this.send(live.controller, { type: 'wait' });
  }

  /** one action through the controller (as a key press would); false when the session refused it locally */
  private send(controller: GameController, a: PlayerAction): boolean {
    this.stats.sent++;
    const out: Outcome = controller.actNow(a);
    if (out.pending) return true;
    this.stats.refused++;
    const why = `${a.type}: ${out.toasts[0]?.text ?? '-'}`;
    this.stats.refusals[why] = (this.stats.refusals[why] ?? 0) + 1;
    this.mem.lastAction = a;
    this.mem.lastInvalid = out.toasts[0]?.text ?? 'refused';
    this.mem.lastReason = 'illegal';
    return false;
  }

  /** a chat line about every chatEvery entries */
  private chatScript(): void {
    const every = this.chatEvery;
    if (!every || !this.stats.on) return;
    const c = this.host.client;
    const bucket = Math.floor(c.n / every);
    if (bucket <= this.chatBucket) return;
    this.chatBucket = bucket;
    if (this.host.say(`autoplay at ${c.n}: line ${this.stats.said + 1}`)) this.stats.said++;
  }
}
