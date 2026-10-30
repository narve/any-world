/**
 * Party turns: one call resolves the inputs of every player and then moves the world once.
 * `step` (index.ts) and the simulator's in-place `fastStep` both run on `runTurn`, so a single
 * player is a party of one going through exactly the same code.
 *
 * Resolution order (deterministic, docs/progress/MP1-DESIGN.md §2.2):
 *   1. free actions (talk, choose_option, choose_perk, toggle_sneak), in input order;
 *   2. turn actions, at most one per player, in the party order rotated by `turn % party.length`
 *      (a fair first mover on contested tiles), each checked against the state at its moment;
 *   3. busy flags of inputs that brought no successful turn action;
 *   4. if a turn action succeeded (or `advance` is set), every other ready player waits and the
 *      world runs; otherwise only quests are checked (a party that only chats loses nothing);
 *   5. an area change the exit countdown left pending (area.ts tickExitCountdown) runs now;
 *   6. end check, every player's fog, rng saved.
 * A refused action changes nothing (rng, log and events are put back) and gets a reason.
 */
import type { PlayerAction, PlayerId, Pos, Refusal, TurnInput, TurnOptions, TurnOutcome } from './types';
import { type Ctx, actorAt, findActor, findFreeNear, isAlive, playerActorOf, timed, withPlayer } from './ctx';
import { doPlayerAction, moveOn } from './actions';
import { exitPending, nearestFreeFloor } from './area';
import { ACT_COST, canTakeTurn, checkEnd, isStanding, runWorld } from './turn';
import { checkQuests } from './gm';
import { updateFov } from './vision';
import { hasFlag } from './stats';
import { closeChoice, talkingWith } from './npc';
import { dropPack } from './inventory';
import { rngFromState } from './rng';
import { DIR_LIST, addDir, samePos } from './util';

/** actions that never cost a turn: resolved first, and open to players without energy */
export const FREE_ACTIONS: ReadonlySet<PlayerAction['type']> = new Set(['talk', 'choose_option', 'choose_perk', 'toggle_sneak']);

export interface TurnCore {
  outcomes: TurnOutcome[];
  waited: PlayerId[];
  /** the world moved (some turn action succeeded, or `advance`) */
  tookTurn: boolean;
  /** anything changed at all (an action succeeded, a busy flag, the world): false = the input state stands */
  changed: boolean;
}

/** standing players with the energy for a turn action who are not stunned, in party order */
export function readyIds(ctx: Ctx): PlayerId[] {
  return ctx.s.party.filter((id) => {
    if (!isStanding(ctx, id)) return false;
    const a = playerActorOf(ctx, id)!;
    return a.energy >= ACT_COST && !hasFlag(ctx, a, 'stunned');
  });
}

/** the party order this turn's turn actions resolve in (rotated by the turn number) */
export function resolutionOrder(party: readonly PlayerId[], turn: number): PlayerId[] {
  const k = party.length ? turn % party.length : 0;
  return [...party.slice(k), ...party.slice(0, k)];
}

interface Pending {
  idx: number;
  pid: PlayerId;
  action: PlayerAction;
}

/** resolves one party turn on `ctx` in place (see the module comment) */
export function runTurn(ctx: Ctx, inputs: readonly TurnInput[], opts: TurnOptions = {}): TurnCore {
  return timed(ctx, 'turn', () => runTurnCore(ctx, inputs, opts));
}

function runTurnCore(ctx: Ctx, inputs: readonly TurnInput[], opts: TurnOptions): TurnCore {
  const s = ctx.s;
  const startArea = s.area;
  const outcomes: TurnOutcome[] = [];
  const free: Pending[] = [];
  const turnByPlayer = new Map<PlayerId, Pending>();
  const extra: Pending[] = [];
  for (const input of Array.isArray(inputs) ? inputs : []) {
    const pid = input?.playerId;
    for (const action of Array.isArray(input?.actions) ? input.actions : []) {
      const p: Pending = { idx: outcomes.length, pid, action };
      outcomes.push({ playerId: pid, action, ok: false, tookTurn: false });
      const type = action && typeof action === 'object' ? (action as { type?: unknown }).type : undefined;
      if (FREE_ACTIONS.has(type as PlayerAction['type'])) free.push(p);
      else if (turnByPlayer.has(pid)) extra.push(p);
      else turnByPlayer.set(pid, p);
    }
  }
  let changed = false;
  let anyTurn = false;
  const acted = new Set<PlayerId>();

  const refuse = (p: Pending, reason: Refusal, detail: string) => {
    const o = outcomes[p.idx];
    o.reason = reason;
    o.detail = detail;
    ctx.events.push({ type: 'invalid', reason: detail });
  };
  const resolve = (p: Pending, isTurn: boolean) => {
    const { pid, action } = p;
    if (s.status !== 'playing') return refuse(p, 'stale', 'the run is over');
    const ps = typeof pid === 'string' && s.party.includes(pid) ? s.players[pid] : undefined;
    if (!ps || !playerActorOf(ctx, pid)) return refuse(p, 'illegal', 'no such player');
    if (s.area !== startArea) return refuse(p, 'area changed', 'the party has moved on');
    if (ps.down) return refuse(p, 'down', 'you are down');
    if (isTurn && acted.has(pid)) return refuse(p, 'illegal', 'already acted this turn');
    if (isTurn && !canTakeTurn(ctx, pid)) return refuse(p, 'not ready', 'not your turn yet');
    const snap = { rng: ctx.rng.state(), log: s.log.slice(), events: ctx.events.length };
    const r = withPlayer(ctx, pid, () => doPlayerAction(ctx, action));
    if (!r.ok) {
      // a refused action leaves no trace (a confused stumble's roll, a "locked" line)
      ctx.rng = rngFromState(snap.rng);
      s.log = snap.log;
      ctx.events.length = snap.events;
      return refuse(p, changed ? refusalAfterChange(ctx, pid, action) : 'illegal', r.reason ?? 'not possible');
    }
    changed = true;
    const o = outcomes[p.idx];
    o.ok = true;
    if (r.tookTurn) {
      o.tookTurn = true;
      anyTurn = true;
      acted.add(pid);
      const pa = playerActorOf(ctx, pid);
      // (a player downed by their own action, a self-harming item, keeps the 0 energy of the down)
      if (pa && !ps.down) pa.energy -= r.cost ?? ACT_COST;
      // busy lasts only between actions
      delete ps.busySince;
    } else if (action.type === 'choose_option' && !ps.pendingChoice) {
      // the dialogue is over (an input still typing sets busy again below)
      delete ps.busySince;
    }
  };

  for (const p of free) resolve(p, false);
  for (const pid of resolutionOrder(s.party, s.turn)) {
    const p = turnByPlayer.get(pid);
    if (p) resolve(p, true);
  }
  // inputs from players outside the party, and second turn actions
  for (const [pid, p] of turnByPlayer) if (!s.party.includes(pid)) resolve(p, true);
  for (const p of extra) resolve(p, true);

  for (const input of Array.isArray(inputs) ? inputs : []) {
    if (typeof input?.busy !== 'boolean' || acted.has(input.playerId)) continue;
    const ps = s.party.includes(input.playerId) ? s.players[input.playerId] : undefined;
    if (!ps || ps.down) continue;
    if (input.busy && ps.busySince == null) {
      ps.busySince = s.turn;
      changed = true;
    } else if (!input.busy && ps.busySince != null && !ps.pendingChoice) {
      // (an open choice stays busy from when it opened: clearing it would lift the time cap)
      delete ps.busySince;
      changed = true;
    }
  }

  const waited: PlayerId[] = [];
  let tookTurn = false;
  ctx.pid = s.party[0];
  if (s.status === 'playing' && (anyTurn || opts.advance)) {
    for (const id of readyIds(ctx)) {
      if (acted.has(id)) continue;
      playerActorOf(ctx, id)!.energy -= ACT_COST;
      waited.push(id);
    }
    tookTurn = true;
    changed = true;
    runWorld(ctx);
    // the exit countdown ran out during the world's rounds: everyone moves on now
    if (s.status === 'playing' && exitPending(ctx)) moveOn(ctx, s.area.exitCountdown!.by);
  } else if (changed) {
    checkQuests(ctx);
  }
  if (changed) {
    if (s.status === 'playing') checkEnd(ctx);
    updateFov(ctx);
    s.rng = ctx.rng.state();
  }
  return { outcomes, waited, tookTurn, changed };
}

/**
 * The reason for a refusal that came after an earlier action of the same turn changed the state:
 * `contested` when the tile or the target was taken by then, else `stale`.
 */
function refusalAfterChange(ctx: Ctx, pid: PlayerId, action: PlayerAction): Refusal {
  const pa = playerActorOf(ctx, pid);
  if (!pa) return 'stale';
  switch (action.type) {
    case 'move': {
      if (!DIR_LIST.includes(action.dir)) return 'stale';
      return actorAt(ctx, addDir(pa.pos, action.dir)) ? 'contested' : 'stale';
    }
    case 'attack':
    case 'persuade':
    case 'talk': {
      const t = findActor(ctx, action.targetId);
      return !t || !isAlive(ctx, t) || withPlayer(ctx, pid, () => talkingWith(ctx, t)) ? 'contested' : 'stale';
    }
    case 'pickup':
      return ctx.s.area.items.some((fi) => samePos(fi.pos, pa.pos)) ? 'stale' : 'contested';
    default:
      return 'stale';
  }
}

// ---------------------------------------------------------------------------
// Leaving and returning (MP2: a room seat away for 2 minutes, docs/progress/MP2-DESIGN.md §10a)
// ---------------------------------------------------------------------------

/**
 * A free tile next to `near`'s actor (the lead's when `near` is not a party member on the map), for
 * a late joiner or a returning player.
 */
export function spotNear(ctx: Ctx, near: PlayerId | undefined): Pos {
  const s = ctx.s;
  const anchor = (near !== undefined && s.party.includes(near) ? playerActorOf(ctx, near) : undefined) ?? playerActorOf(ctx, s.party[0]);
  return (anchor && (findFreeNear(ctx, anchor.pos, 3) ?? nearestFreeFloor(ctx, anchor.pos))) ?? nearestFreeFloor(ctx, s.area.map.start) ?? { ...s.area.map.start };
}

/** why `pid` cannot leave the map now (null = it can) */
export function leaveFailure(ctx: Ctx, pid: PlayerId): string | null {
  const s = ctx.s;
  if (s.status !== 'playing') return 'the run is over';
  if (!s.party.includes(pid) || !playerActorOf(ctx, pid)) return `no player "${pid}" on the map`;
  if (s.party.length < 2) return 'the last party member cannot leave';
  if (s.party.every((id) => id === pid || s.players[id].down)) return 'every other party member is down';
  return null;
}

/**
 * `pid`'s character leaves the map (in place): its pack and equipment drop where it stood, its open
 * choice closes, hostiles drop it as a target and its allies follow the lead. It leaves `party` but
 * stays in `players` with `left` (its actor as it left, without statuses or temporary mods).
 */
export function leaveCore(ctx: Ctx, pid: PlayerId): void {
  const err = leaveFailure(ctx, pid);
  if (err) throw new Error(err);
  const s = ctx.s;
  const ps = s.players[pid];
  const a = playerActorOf(ctx, pid)!;
  withPlayer(ctx, pid, () => {
    closeChoice(ctx, ps);
    dropPack(ctx);
  });
  s.area.actors = s.area.actors.filter((x) => x !== a);
  s.party = s.party.filter((id) => id !== pid);
  const lead = playerActorOf(ctx, s.party[0])!;
  for (const x of s.area.actors) {
    if (x.ai.targetId === a.id) delete x.ai.targetId;
    if (x.allyOf === a.id) x.allyOf = lead.id;
  }
  if (s.area.exitCountdown?.by === pid) s.area.exitCountdown.by = s.party[0];
  a.statuses = [];
  a.tempMods = [];
  a.energy = 0;
  a.ai = { alerted: false };
  ps.left = { turn: s.turn, actor: a };
  ps.sneaking = false;
  ps.seen = new Uint8Array(0);
  delete ps.away;
  delete ps.awaySince;
  delete ps.busySince;
  delete ps.down;
  ctx.pid = s.party[0];
}

/**
 * A player who left comes back next to `near` (in place): the actor it left with (level, perks, the
 * hp it had, at least 1), an empty pack, fresh fog, at the end of the party order.
 */
export function returnCore(ctx: Ctx, pid: PlayerId, near: PlayerId | undefined, maxParty: number): void {
  const s = ctx.s;
  const ps = s.players[pid];
  if (s.status !== 'playing') throw new Error('the run is over');
  if (!ps?.left) throw new Error(`player "${pid}" has not left the map`);
  if (s.party.length >= maxParty) throw new Error(`the party is full (${maxParty})`);
  const a = ps.left.actor;
  a.pos = spotNear(ctx, near);
  a.hp = Math.max(1, a.hp);
  a.energy = ACT_COST;
  a.ai = { alerted: false };
  s.area.actors.push(a);
  delete ps.left;
  ps.seen = new Uint8Array(s.area.map.width * s.area.map.height);
  s.party.push(pid);
}
