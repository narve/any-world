/**
 * What the in-game party UI shows (MP3 design §3), DOM-free: one entry per party member (seat
 * colour and name from the roster, hp and position from the replica, a state for the chip and name
 * tag), the turn indicator from the last `clock` frame ("2 of 3 acted", "Kari is deciding"), its
 * show / hide delays (PillTimer: never a flicker while turns resolve in 100–600 ms), and the one
 * banner (down with the spectator camera, or the exit countdown). The DOM side is room-ui.ts.
 *
 * Nothing here waits on the clock: the pill only says what the others are doing.
 */
import type { GameState, PlayerId, Pos } from '../../engine/types';
import { REVIVE_SELF_TURNS } from '../../engine/turn';
import type { ClockMsg, RosterEntry } from '../../net/protocol';

/** what a party chip and name tag say about a member, most important first */
export type MemberState = 'left' | 'down' | 'away' | 'busy' | 'acted' | 'deciding' | 'playing';

export interface PartyMember {
  pid: PlayerId;
  seat: string | null;
  name: string;
  colour: string;
  actorId: string | null;
  pos: Pos | null;
  hp: number;
  maxHp: number;
  /** this page's player */
  you: boolean;
  state: MemberState;
  /** the spectator camera follows this member */
  followed: boolean;
}

/** a member without a seat (left the room): grey */
export const NO_SEAT_COLOUR = '#8a8f98';

/** the turn pill shows after this much waiting and hides this long after the turn resolved (design constants) */
export const PILL_TIMING = { showMs: 450, hideMs: 250 } as const;

/** roster presences that read as "away" on a chip or tag */
const AWAY = new Set(['off', 'idle']);
/** roster presences of a player in a dialogue, a trade, a menu or the chat */
const BUSY = new Set(['busy', 'menu']);

/**
 * The party in the replica, this player first, then the others in party order and those who left. `clock` counts only
 * while it is for the next entry (`n`); an older frame is a turn that has resolved.
 */
export function partyMembers(s: GameState, roster: readonly RosterEntry[], clock: ClockMsg | null, n: number, me: PlayerId, followed: PlayerId | null): PartyMember[] {
  const fresh = clock && clock.n === n ? clock : null;
  const acted = new Set(fresh?.acted ?? []);
  const waiting = new Set(fresh?.waiting ?? []);
  // (players who left the map are out of `party` but kept in `players`: their chips stay, greyed)
  const gone = Object.keys(s.players).filter((id) => id !== me && !s.party.includes(id));
  const order = [me, ...s.party.filter((id) => id !== me), ...gone].filter((id) => s.players[id]);
  return order.map((pid) => {
    const ps = s.players[pid];
    const seat = roster.find((r) => r.pid === pid) ?? null;
    const actor = s.area.actors.find((a) => a.id === ps.actorId) ?? null;
    let state: MemberState = 'playing';
    if (ps.left || !seat || seat.presence === 'gone') state = 'left';
    else if (ps.down) state = 'down';
    else if (AWAY.has(seat.presence) || !seat.connected) state = 'away';
    else if (acted.has(pid)) state = 'acted';
    else if (BUSY.has(seat.presence)) state = 'busy';
    else if (waiting.has(pid)) state = 'deciding';
    return {
      pid,
      seat: seat?.seat ?? null,
      name: seat?.name ?? ps.name,
      colour: seat?.colour ?? NO_SEAT_COLOUR,
      actorId: actor ? actor.id : null,
      pos: actor ? { ...actor.pos } : null,
      hp: actor?.hp ?? 0,
      maxHp: actor?.maxHp ?? 0,
      you: pid === me,
      state,
      followed: pid === followed,
    };
  });
}

export interface TurnView {
  /** someone acted and an active player has not: the turn is waiting on them */
  waiting: boolean;
  acted: number;
  total: number;
  /** this player acted (the pill names who is deciding instead of counting) */
  mine: boolean;
  /** the first active player who has not acted */
  deciding: string | null;
  /** time left until the deadline resolves the turn anyway, when the clock gave one */
  deadlineMs: number | null;
}

/** the turn indicator from the last clock frame (null clock or an older turn: not waiting) */
export function turnView(members: readonly PartyMember[], clock: ClockMsg | null, n: number, me: PlayerId): TurnView {
  const fresh = clock && clock.n === n ? clock : null;
  const acted = fresh?.acted.length ?? 0;
  const left = fresh?.waiting ?? [];
  const total = acted + left.length;
  const first = left.find((p) => p !== me);
  return {
    waiting: members.length >= 2 && acted > 0 && left.length > 0,
    acted,
    total,
    mine: !!fresh?.acted.includes(me),
    deciding: first ? (members.find((m) => m.pid === first)?.name ?? null) : null,
    deadlineMs: fresh?.deadlineInMs ?? null,
  };
}

/**
 * The turn pill's show / hide delays: shown once the turn has been waiting for PILL_TIMING.showMs,
 * hidden PILL_TIMING.hideMs after it stopped waiting (a new wait meanwhile keeps it up).
 */
export class PillTimer {
  private since: number | null = null;
  private offAt: number | null = null;
  shown = false;

  /** `since`: when the wait began, if known (the clock frame's arrival), else `now` the first time */
  update(waiting: boolean, now: number, since?: number): boolean {
    if (waiting) {
      this.offAt = null;
      this.since ??= Math.min(now, since ?? now);
      if (now - this.since >= PILL_TIMING.showMs) this.shown = true;
    } else {
      this.since = null;
      if (this.shown) {
        this.offAt ??= now;
        if (now - this.offAt >= PILL_TIMING.hideMs) {
          this.shown = false;
          this.offAt = null;
        }
      }
    }
    return this.shown;
  }
}

/** the one banner of the game screen (the reconnect banner, shown by the UI root, comes first) */
export type BannerView =
  /** this player is down: when they get up, and whom the camera follows */
  | { kind: 'down'; turnsLeft: number; watching: string | null; canCycle: boolean }
  /** the exit countdown; `by` null: this player took the exit */
  | { kind: 'exit'; turnsLeft: number; by: string | null };

/** banner priority: down / spectator > exit countdown (the reconnect banner is above both) */
export function bannerView(s: GameState, members: readonly PartyMember[], me: PlayerId): BannerView | null {
  const ps = s.players[me];
  if (ps?.down && s.status === 'playing') {
    const watched = members.find((m) => m.followed) ?? null;
    const standing = members.filter((m) => !m.you && m.state !== 'down' && m.state !== 'left').length;
    return { kind: 'down', turnsLeft: Math.max(0, REVIVE_SELF_TURNS - (s.turn - ps.down.since)), watching: watched?.name ?? null, canCycle: standing > 1 };
  }
  const cd = s.area.exitCountdown;
  if (cd && s.status === 'playing') {
    const by = cd.by === me ? null : (members.find((m) => m.pid === cd.by)?.name ?? s.players[cd.by]?.name ?? null);
    return { kind: 'exit', turnsLeft: cd.turnsLeft, by };
  }
  return null;
}

/** pid → actor id → seat colour, for renderer.setPartyColours (members without an actor or a seat are left out) */
export function partyColours(members: readonly PartyMember[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of members) if (m.actorId && m.seat) out.set(m.actorId, m.colour);
  return out;
}
