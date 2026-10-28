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
  /** ms per party turn (bot decisions and engine calls) */
  turnMs: number[];
  /** ms per party turn spent inside the engine (every stepTurn of that turn, free actions included) */
  engineMs: number[];
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
  /** players who went down, and who got back up (events `downed` / `revived`) */
  downs: number;
  revives: number;
  /** revives where a teammate stood next to the down player */
  helpedRevives: number;
  /** players who used their second chance (fell once and got straight back up) */
  secondChances: number;
  /** players who fell at least once (a second chance used, or down) */
  playersFell: number;
  /** per boss killed (unique hostile): engine rounds from the first time a player saw it to its death */
  bossRounds: number[];
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
  const timing: PartyTiming | undefined = opts.now ? { turnMs: [], engineMs: [], split: {} } : undefined;
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
    downs: 0,
    revives: 0,
    helpedRevives: 0,
    secondChances: 0,
    playersFell: 0,
    bossRounds: [],
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
  const fell = new Set<PlayerId>();
  // boss fights: actor id → the round a player first saw it (bossRounds)
  const uniques = new Set(world.actors.filter((d) => d.unique && !d.npc).map((d) => d.id));
  const bossSeen = new Map<string, number>();
  const watchBosses = () => {
    if (!uniques.size) return;
    const width = s.area.map.width;
    for (const a of s.area.actors) {
      if (a.hp <= 0 || a.faction !== 'hostile' || !uniques.has(a.defId) || bossSeen.has(a.id)) continue;
      const i = a.pos.y * width + a.pos.x;
      if (s.party.some((id) => s.players[id].seen[i] === 2)) bossSeen.set(a.id, s.turn);
    }
  };
  const tally = (r: TurnResult) => {
    for (const e of r.events) {
      if (e.type === 'died') {
        const since = bossSeen.get(e.actorId);
        if (since !== undefined) {
          res.bossRounds.push(r.state.turn - since);
          bossSeen.delete(e.actorId);
        }
      } else if (e.type === 'downed') {
        res.downs++;
        fell.add(e.playerId);
      }
      else if (e.type === 'revived') {
        res.revives++;
        if (e.helped) res.helpedRevives++;
      }
    }
    for (const o of r.outcomes) {
      const m = mems.get(o.playerId);
      if (m) {
        m.lastAction = o.action;
        m.lastInvalid = o.ok ? null : (o.detail ?? 'refused');
        m.lastReason = o.ok ? null : (o.reason ?? null);
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
    res.secondChances = s.party.filter((id) => s.players[id].mercyUsed).length;
    res.playersFell = s.party.filter((id) => s.players[id].mercyUsed || fell.has(id)).length;
    res.areaReached = Math.max(res.areaReached, s.area.index);
    return res;
  };
  watchBosses();
  let lastKey = partyProgressKey(s);
  let lastProgress = 0;

  for (;;) {
    if (s.status === 'won') return finish('won', s.endReason ?? 'goal reached');
    if (s.status === 'lost') return finish('lost', s.endReason ?? 'lost');
    if (s.turn >= maxTurns) return finish('timeout', `turn cap ${maxTurns} reached in area ${s.area.index}`);
    const t0 = opts.now?.();
    const engine0 = timing?.split.turn ?? 0;
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
    watchBosses();
    res.partyTurns++;
    if (s.area.index > res.areaReached) res.areaReached = s.area.index;
    const ms = t0 !== undefined && opts.now ? opts.now() - t0 : undefined;
    if (timing && ms !== undefined) {
      timing.turnMs.push(ms);
      timing.engineMs.push((timing.split.turn ?? 0) - engine0);
    }
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

// ---------------------------------------------------------------------------
// Summaries (tools/sim.ts --party)
// ---------------------------------------------------------------------------

export interface TimeStats {
  /** samples (party turns) */
  n: number;
  mean: number;
  p95: number;
  max: number;
}

/** mean / 95th percentile (nearest rank) / max of a list of ms */
export function timeStats(xs: number[]): TimeStats {
  if (!xs.length) return { n: 0, mean: 0, p95: 0, max: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  return { n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length, p95, max: sorted[sorted.length - 1] };
}

export interface PartyTimingSummary {
  /** the whole party turn: bot decisions and engine calls */
  turn: TimeStats;
  /** the engine's share of each party turn */
  engine: TimeStats;
  /** the bots' share (turn − engine) */
  bots: TimeStats;
  /** mean ms per party turn by engine key (turn, world, ai, fov) */
  split: Record<string, number>;
}

export interface PartySummary {
  partySize: number;
  runs: number;
  won: number;
  lost: number;
  stuck: number;
  crash: number;
  timeout: number;
  winRate: number;
  avgTurns: number;
  avgPartyTurns: number;
  downs: number;
  revives: number;
  helpedRevives: number;
  secondChances: number;
  /** share of players (over all runs) who fell at least once: a second chance used, or down */
  fellRate: number;
  /** bosses killed, and the mean rounds from a boss's first sight to its death */
  bossKills: number;
  bossRounds: number;
  refusals: Record<Refusal, number>;
  /** outcome → cause → runs (won left out) */
  causes: Record<Exclude<SimOutcome, 'won'>, Record<string, number>>;
  /** seeds per outcome (for repros) */
  seeds: Record<SimOutcome, number[]>;
  /** area index → runs that ended there */
  areaHistogram: number[];
  anomalies: string[];
  timing?: PartyTimingSummary;
}

/** one summary per party size, in ascending size */
export function summarizeParty(results: PartyResult[], areaCount: number): PartySummary[] {
  const sizes = [...new Set(results.map((r) => r.partySize))].sort((a, b) => a - b);
  return sizes.map((n) => {
    const list = results.filter((r) => r.partySize === n);
    const count = (o: SimOutcome) => list.filter((r) => r.result === o).length;
    const sum = (f: (r: PartyResult) => number) => list.reduce((a, r) => a + f(r), 0);
    const refusals = Object.fromEntries(REFUSALS.map((k) => [k, sum((r) => r.refusals[k])])) as Record<Refusal, number>;
    const causes = { lost: {}, stuck: {}, timeout: {}, crash: {} } as PartySummary['causes'];
    const seeds = { won: [], lost: [], stuck: [], crash: [], timeout: [] } as Record<SimOutcome, number[]>;
    const hist = Array.from({ length: Math.max(areaCount, 1) }, () => 0);
    for (const r of list) {
      seeds[r.result].push(r.seed);
      hist[Math.min(r.areaReached, hist.length - 1)]++;
      if (r.result === 'won') continue;
      const c = r.result === 'crash' ? r.cause.split(' @ ')[0] : r.cause;
      causes[r.result][c] = (causes[r.result][c] ?? 0) + 1;
    }
    const timed = list.filter((r) => r.timing);
    let timing: PartyTimingSummary | undefined;
    if (timed.length) {
      const turn = timed.flatMap((r) => r.timing!.turnMs);
      const engine = timed.flatMap((r) => r.timing!.engineMs);
      const split: Record<string, number> = {};
      for (const r of timed) for (const [k, v] of Object.entries(r.timing!.split)) split[k] = (split[k] ?? 0) + v;
      for (const k of Object.keys(split)) split[k] /= Math.max(1, turn.length);
      timing = { turn: timeStats(turn), engine: timeStats(engine), bots: timeStats(turn.map((t, i) => t - engine[i])), split };
    }
    return {
      partySize: n,
      runs: list.length,
      won: count('won'),
      lost: count('lost'),
      stuck: count('stuck'),
      crash: count('crash'),
      timeout: count('timeout'),
      winRate: list.length ? count('won') / list.length : 0,
      avgTurns: list.length ? sum((r) => r.turns) / list.length : 0,
      avgPartyTurns: list.length ? sum((r) => r.partyTurns) / list.length : 0,
      downs: sum((r) => r.downs),
      revives: sum((r) => r.revives),
      helpedRevives: sum((r) => r.helpedRevives),
      secondChances: sum((r) => r.secondChances),
      fellRate: list.length ? sum((r) => r.playersFell) / sum((r) => r.partySize) : 0,
      bossKills: sum((r) => r.bossRounds.length),
      bossRounds: sum((r) => r.bossRounds.length) ? sum((r) => r.bossRounds.reduce((a, b) => a + b, 0)) / sum((r) => r.bossRounds.length) : 0,
      refusals,
      causes,
      seeds,
      areaHistogram: hist,
      anomalies: list.flatMap((r) => r.anomalies),
      ...(timing ? { timing } : {}),
    };
  });
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const ms = (t: TimeStats) => `mean ${t.mean.toFixed(1)}  p95 ${t.p95.toFixed(1)}  max ${t.max.toFixed(1)} ms`;

/** a plain-text table for the CLI and reports */
export function formatPartySummary(title: string, sums: PartySummary[]): string {
  const lines = [`== ${title}`, 'party  runs   won  lost stuck crash  t/o  avgTurns  fell  downs  up(helped)  bossRounds(kills)  refusals: contested stale area-changed not-ready down ILLEGAL  areas reached (0..n)'];
  for (const s of sums) {
    const r = s.refusals;
    lines.push(
      [
        String(s.partySize).padStart(5),
        String(s.runs).padStart(5),
        pct(s.winRate).padStart(5),
        pct(s.lost / s.runs).padStart(5),
        pct(s.stuck / s.runs).padStart(5),
        pct(s.crash / s.runs).padStart(5),
        pct(s.timeout / s.runs).padStart(5),
        s.avgTurns.toFixed(0).padStart(9),
        pct(s.fellRate).padStart(5),
        String(s.downs).padStart(6),
        `${s.revives}(${s.helpedRevives})`.padStart(11),
        `${s.bossRounds.toFixed(1)}(${s.bossKills})`.padStart(18),
        '          ' + [r.contested, r.stale, r['area changed'], r['not ready'], r.down, r.illegal].join(' / '),
        '  ' + s.areaHistogram.join(' / '),
      ].join(' '),
    );
  }
  for (const s of sums) {
    const top = (t: Record<string, number>) =>
      Object.entries(t)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${v}× ${k}`)
        .join('; ');
    if (s.lost) lines.push(`  ${s.partySize}p lost: ${top(s.causes.lost)} (seeds ${s.seeds.lost.slice(0, 8).join(', ')})`);
    if (s.stuck) lines.push(`  ${s.partySize}p stuck: ${top(s.causes.stuck)} (seeds ${s.seeds.stuck.slice(0, 8).join(', ')})`);
    if (s.timeout) lines.push(`  ${s.partySize}p timed out: ${top(s.causes.timeout)} (seeds ${s.seeds.timeout.slice(0, 8).join(', ')})`);
    if (s.crash) lines.push(`  ${s.partySize}p CRASH: ${top(s.causes.crash)} (seeds ${s.seeds.crash.slice(0, 8).join(', ')})`);
    if (s.anomalies.length) lines.push(`  ${s.partySize}p anomalies:\n    ${s.anomalies.slice(0, 8).join('\n    ')}`);
    if (s.timing) {
      const t = s.timing;
      lines.push(`  ${s.partySize}p party turn ${ms(t.turn)} (${t.turn.n} turns)`);
      lines.push(`  ${s.partySize}p   engine   ${ms(t.engine)}; per turn: ${Object.entries(t.split).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}`);
      lines.push(`  ${s.partySize}p   bots     ${ms(t.bots)}`);
    }
  }
  return lines.join('\n');
}

/**
 * The bots of a party of `size`: player i plays `names[(i + offset) % names.length]`. tools/sim.ts
 * passes the seed as offset, so over a few seeds every bot leads and every pairing is played.
 */
export function partyBots(names: BotName[], size: number, offset = 0): BotName[] {
  const list = names.length ? names : (['explorer'] as BotName[]);
  return Array.from({ length: size }, (_, i) => list[(i + offset) % list.length]);
}
