/**
 * Party simulator (MP1): plays one game with a bot per player through the party turn API and
 * classifies the outcome like runGame (won / lost / stuck / timeout / crash).
 *
 * One party turn: for each player in party order, its bot decides; free actions (talk, choices,
 * perks, sneaking) are applied at once, alone (at most MAX_FREE_PER_TURN per player and turn), and
 * the first turn action of a ready player is kept; then one stepTurn with every kept turn action
 * and `advance`, so the world moves even when every action was refused. Players out of energy
 * (a hasted teammate's extra turn) only answer open choices. Refusals are counted by reason.
 *
 * Timing never reads a clock here: the caller passes `now` (tools/sim.ts uses performance.now).
 */
import type { WorldSpec } from '../../schema/world';
import type { Difficulty } from '../../schema/gm';
import type { GameState, PlayerAction, PlayerId, Refusal, TurnInput, TurnResult } from '../types';
import { createGame, readyPlayers, stepTurn } from '../index';
import { FREE_ACTIONS } from '../party';
import { type Bot, type BotMemory, type BotName, botByName, newMemory } from './bots';
import { fastStepTurn } from './fast';
import { invariantError, type RunOptions, type SimOutcome } from './run';

/** free actions one player may take in one party turn (a dialogue answered, a perk chosen…) */
export const MAX_FREE_PER_TURN = 8;

export interface PartyTurnInfo {
  state: GameState;
  result: TurnResult;
  /** ms for the whole party turn (free actions included), when `now` was given */
  ms?: number;
}

export interface PartyRunOptions extends Omit<RunOptions, 'onStep' | 'gm'> {
  /** player names (default P1, P2…) */
  names?: string[];
  /** called after every party turn */
  onTurn?: (info: PartyTurnInfo) => void;
  /** the caller's clock in ms (timing is off without it) */
  now?: () => number;
}

export interface PartyTiming {
  /** ms per party turn */
  turnMs: number[];
  /** total ms per engine key ('turn', 'world', 'ai', 'fov') */
  split: Record<string, number>;
}

export interface PartyResult {
  world: string;
  seed: number;
  bots: string[];
  partySize: number;
  difficulty: Difficulty;
  result: SimOutcome;
  /** engine turns (rounds) */
  turns: number;
  /** party turns played (joint stepTurn calls) */
  partyTurns: number;
  areaReached: number;
  cause: string;
  /** refused actions by reason (free and turn actions alike) */
  refusals: Record<Refusal, number>;
  /** engine anomalies worth a bug report (illegal refusals, invariant breaks) */
  anomalies: string[];
  timing?: PartyTiming;
}

const REFUSALS: Refusal[] = ['not ready', 'down', 'contested', 'stale', 'area changed', 'illegal'];

/** what counts as progress for the stall check: any player's discoveries, items, xp; flags, kills, areas */
function partyProgressKey(s: GameState): string {
  const parts: (string | number)[] = [s.area.index, Object.values(s.defeated).reduce((a, b) => a + b, 0), Object.keys(s.flags).filter((k) => s.flags[k]).length, s.stats.damageDealt, s.quests.length, s.purse];
  parts.push(Object.entries(s.counters).map(([k, v]) => `${k}${v}`).join(','));
  for (const id of s.party) {
    const p = s.players[id];
    let seen = 0;
    for (let i = 0; i < p.seen.length; i++) if (p.seen[i]) seen++;
    const items = p.slots.reduce((n, it) => n + (it ? it.count + 1 : 0), 0);
    const kn = Object.values(p.knowledge).map((k) => k.level[0]).join('');
    parts.push(seen, items, p.xp, p.level, kn, p.equipped.weapon ?? '-', p.equipped.armour ?? '-');
  }
  return parts.join('|');
}

/** plays one party game; never throws (engine/bot errors become `crash`) */
export function runParty(world: WorldSpec, seed: number, botsIn: (Bot | BotName)[], opts: PartyRunOptions = {}): PartyResult {
  const bots = (botsIn.length ? botsIn : ['explorer' as BotName]).map((b) => (typeof b === 'string' ? botByName(b) : b));
  const maxTurns = opts.maxTurns ?? 3000;
  const stallSteps = opts.stallSteps ?? 400;
  const checkInv = opts.invariants ?? true;
  const refusals = Object.fromEntries(REFUSALS.map((r) => [r, 0])) as Record<Refusal, number>;
  const timing: PartyTiming | undefined = opts.now ? { turnMs: [], split: {} } : undefined;
  const profile = opts.now && timing ? { now: opts.now, add: (k: string, ms: number) => void (timing.split[k] = (timing.split[k] ?? 0) + ms) } : undefined;
  const res: PartyResult = {
    world: world.meta.title,
    seed,
    bots: bots.map((b) => b.name),
    partySize: bots.length,
    difficulty: opts.difficulty ?? 'normal',
    result: 'timeout',
    turns: 0,
    partyTurns: 0,
    areaReached: 0,
    cause: '',
    refusals,
    anomalies: [],
    ...(timing ? { timing } : {}),
  };
  let s: GameState;
  try {
    s = createGame(world, {
      seed,
      players: bots.map((_, i) => ({ name: opts.names?.[i] ?? `P${i + 1}` })),
      ...(opts.difficulty ? { difficulty: opts.difficulty } : {}),
      ...(opts.mapGenerator ? { mapGenerator: opts.mapGenerator } : {}),
    });
    res.difficulty = s.difficulty ?? 'normal';
  } catch (e) {
    return { ...res, result: 'crash', cause: `engine: createGame threw: ${errText(e)}` };
  }
  const env = { world, ...(opts.mapGenerator ? { mapGenerator: opts.mapGenerator } : {}), ...(profile ? { profile } : {}) };
  const turnFn = (st: GameState, inputs: TurnInput[], advance: boolean): TurnResult =>
    opts.fast ? fastStepTurn(st, inputs, world, { advance, ...(opts.mapGenerator ? { mapGenerator: opts.mapGenerator } : {}), ...(profile ? { profile } : {}) }) : stepTurn(st, inputs, { ...env, advance });
  // the lead's bot gets runGame's memory seed, so a party of one plays the same game as runGame
  const mems = new Map<PlayerId, BotMemory>(s.party.map((id, i) => [id, newMemory(i === 0 ? seed : seed * 31 + i)]));
  const botOf = new Map<PlayerId, Bot>(s.party.map((id, i) => [id, bots[i % bots.length]]));
  const tally = (r: TurnResult) => {
    for (const o of r.outcomes) {
      const m = mems.get(o.playerId);
      if (m) {
        m.lastAction = o.action;
        m.lastInvalid = o.ok ? null : (o.detail ?? 'refused');
      }
      if (o.ok || !o.reason) continue;
      refusals[o.reason]++;
      if (o.reason === 'illegal' && res.anomalies.length < 5) res.anomalies.push(`seed ${seed} turn ${s.turn}: ${o.playerId} ${JSON.stringify(o.action)} refused (${o.detail})`);
    }
  };
  const finish = (r: SimOutcome, cause: string): PartyResult => {
    res.result = r;
    res.cause = cause;
    res.turns = s.turn;
    res.areaReached = Math.max(res.areaReached, s.area.index);
    return res;
  };
  let lastKey = partyProgressKey(s);
  let lastProgress = 0;

  for (;;) {
    if (s.status === 'won') return finish('won', s.endReason ?? 'goal reached');
    if (s.status === 'lost') return finish('lost', s.endReason ?? 'lost');
    if (s.turn >= maxTurns) return finish('timeout', `turn cap ${maxTurns} reached in area ${s.area.index}`);
    const t0 = opts.now?.();
    const kept = new Map<PlayerId, TurnInput>();
    try {
      const ready = new Set(readyPlayers(s, env));
      /** one player's decisions: free actions applied at once, the first turn action kept */
      const decide = (pid: PlayerId): SimOutcomeCrash | null => {
        const bot = botOf.get(pid)!;
        const mem = mems.get(pid)!;
        for (let n = 0; ; n++) {
          const ps = s.players[pid];
          if (!ps || ps.down) return null;
          if (!ready.has(pid) && !ps.pendingChoice && !ps.pendingPerkChoice) return null;
          let action: PlayerAction;
          try {
            action = bot.decide(s, world, mem, pid);
          } catch (e) {
            return { cause: `bot: ${bot.name} (${pid}) threw: ${errText(e)}` };
          }
          if (FREE_ACTIONS.has(action?.type)) {
            if (n >= MAX_FREE_PER_TURN) return null;
            const r = turnFn(s, [{ playerId: pid, actions: [action] }], false);
            tally(r);
            s = r.state;
            if (s.status !== 'playing') return null;
            continue;
          }
          if (ready.has(pid)) kept.set(pid, { playerId: pid, actions: [action] });
          return null;
        }
      };
      for (const pid of [...s.party]) {
        if (s.status !== 'playing') break;
        const err = decide(pid);
        if (err) return finish('crash', err.cause);
      }
      // a later player's free action may have opened a choice for an earlier one (shared xp: a
      // level-up); they answer it before their turn action is sent
      for (const pid of [...kept.keys()]) {
        if (s.status !== 'playing') break;
        const ps = s.players[pid];
        if (!ps.pendingChoice && !ps.pendingPerkChoice) continue;
        kept.delete(pid);
        const err = decide(pid);
        if (err) return finish('crash', err.cause);
      }
    } catch (e) {
      return finish('crash', `engine: free action threw: ${errText(e)}`);
    }
    const inputs: TurnInput[] = s.party.filter((id) => kept.has(id)).map((id) => kept.get(id)!);
    if (s.status !== 'playing') continue;
    let r: TurnResult;
    try {
      r = turnFn(s, inputs, true);
    } catch (e) {
      return finish('crash', `engine: stepTurn(${JSON.stringify(inputs)}) threw: ${errText(e)}`);
    }
    tally(r);
    s = r.state;
    res.partyTurns++;
    if (s.area.index > res.areaReached) res.areaReached = s.area.index;
    const ms = t0 !== undefined && opts.now ? opts.now() - t0 : undefined;
    if (timing && ms !== undefined) timing.turnMs.push(ms);
    opts.onTurn?.({ state: s, result: r, ...(ms !== undefined ? { ms } : {}) });
    if (checkInv) {
      const err = invariantError(world, s);
      if (err) {
        res.anomalies.push(`seed ${seed} turn ${s.turn}: ${err}`);
        return finish('crash', `invariant: ${err}`);
      }
    }
    // a party turn where every action was refused is no progress
    const key = partyProgressKey(s);
    if (key !== lastKey && r.outcomes.some((o) => o.ok)) {
      lastKey = key;
      lastProgress = res.partyTurns;
    } else if (res.partyTurns - lastProgress > stallSteps) {
      return finish('stuck', `no progress for ${stallSteps} party turns in area ${s.area.index}`);
    }
  }
}

interface SimOutcomeCrash {
  cause: string;
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const where = e.stack?.split('\n').slice(1, 3).map((l) => l.trim()).join(' / ') ?? '';
    return `${e.message}${where ? ` @ ${where}` : ''}`;
  }
  return String(e);
}
