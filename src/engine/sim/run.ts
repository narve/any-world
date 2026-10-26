/**
 * Simulator: plays one game with a bot and classifies the outcome, plus batch runs and summaries.
 *
 *   won / lost — the engine ended the run
 *   stuck      — no progress (new tiles, areas, kills, items, xp, flags…) for `stallSteps`
 *                decisions, or an endless loop of free actions: a soft-lock or a bot that can't
 *                find its way (the cause says which area and what blocks the way onward)
 *   timeout    — the turn cap was reached while still making progress, or the random bot
 *                stopped making progress ("wandering: …"): a random walk is not a soft-lock, so
 *                its stalls are never reported as stuck
 *   crash      — the engine (or the bot) threw, or a state invariant broke
 */
import type { WorldSpec } from '../../schema/world';
import type { Difficulty } from '../../schema/gm';
import type { GameEvent, GameState, MapGenerator, PlayerAction } from '../types';
import { TOTAL_SLOTS } from '../types';
import { createGame, step, applyGmActions, leadPlayer, transitionBlocker } from '../index';
import { type Bot, type BotName, botByName, newMemory } from './bots';
import { gmActionsForArea, gmIdleActions } from './gm-script';
import { seenCount } from './view';
import { fastStep } from './fast';

export type SimOutcome = 'won' | 'lost' | 'stuck' | 'crash' | 'timeout';

export interface RunOptions {
  /** engine turn cap (rounds), default 3000 */
  maxTurns?: number;
  /** decisions without progress before the run counts as stuck, default 400 */
  stallSteps?: number;
  /** feed scripted GM actions (spawn, offer_choice, add_rule/remove_rule…), default false */
  gm?: boolean;
  /** map generator override (tests) */
  mapGenerator?: MapGenerator;
  /** difficulty band the games are played at (passed to createGame), default 'normal' */
  difficulty?: Difficulty;
  /** check state invariants after every step (slower), default true */
  invariants?: boolean;
  /**
   * step in place instead of through the cloning public step() (about 3× faster; identical results,
   * see sim/fast.ts). Default false.
   */
  fast?: boolean;
  /** called after every step (tracing/debugging) */
  onStep?: (state: GameState, action: PlayerAction, events: GameEvent[]) => void;
}

export interface SimStats {
  kills: number;
  damageDealt: number;
  damageTaken: number;
  itemsUsed: number;
  areasCleared: number;
  level: number;
  /** lowest hp fraction seen */
  hpLow: number;
  talks: number;
  persuades: number;
  interacts: number;
  pickups: number;
  equips: number;
  gmBatches: number;
  gmSkipped: number;
  /** actions from legalActions that step() refused (engine bug when > 0) */
  invalidLegal: number;
  /** player turns spent per area index */
  turnsPerArea: number[];
}

export interface SimResult {
  world: string;
  seed: number;
  bot: string;
  /** the difficulty band the game was actually played at (GameState.difficulty) */
  difficulty: Difficulty;
  result: SimOutcome;
  /** engine turns (rounds) */
  turns: number;
  /** bot decisions (actions sent) */
  steps: number;
  /** highest area index reached (0-based) */
  areaReached: number;
  /** why it ended: killer / loss reason / stuck reason / error */
  cause: string;
  stats: SimStats;
  /** engine anomalies worth a bug report (legal actions refused, invariant breaks) */
  anomalies: string[];
}

const MAX_FREE_STREAK = 40;

function progressKey(s: GameState): string {
  const p = leadPlayer(s);
  const defeated = Object.values(s.defeated).reduce((a, b) => a + b, 0);
  const items = p.slots.reduce((n, it) => n + (it ? it.count + 1 : 0), 0);
  const flags = Object.keys(s.flags).filter((k) => s.flags[k]).length;
  const counters = Object.entries(s.counters).map(([k, v]) => `${k}${v}`).join(',');
  const kn = Object.values(p.knowledge).map((k) => k.level[0]).join('');
  return [s.area.index, seenCount(s), defeated, items, p.xp, p.level, flags, counters, kn, s.stats.damageDealt, s.quests.length, p.equipped.weapon, p.equipped.armour].join('|');
}

/** cheap structural invariants (every player of the party); returns a description of the first violation */
export function invariantError(world: WorldSpec, s: GameState): string | null {
  const map = s.area.map;
  const lead = leadPlayer(s);
  if (!lead) return 'no lead player';
  if (s.party.length !== Object.keys(s.players).length || s.party.some((id) => s.players[id]?.id !== id)) return 'party and players disagree';
  if (new Set(s.party).size !== s.party.length) return 'a player is in the party twice';
  if (map.tiles.length !== map.width * map.height) return 'tile count does not match map size';
  for (const id of s.party) {
    const ps = s.players[id];
    if (ps.seen.length !== map.width * map.height) return `fog of ${id} does not match the map size`;
    if (ps.slots.length !== TOTAL_SLOTS) return `slot array of ${id} has the wrong length`;
    const mine = s.area.actors.filter((a) => a.id === ps.actorId);
    if (mine.length !== 1) return mine.length ? `actor of ${id} is in the area twice` : `actor of ${id} missing from the area`;
    const p = mine[0];
    if (s.party.some((o) => o !== id && s.players[o].actorId === ps.actorId)) return `${id} shares an actor with another player`;
    if (ps.down) {
      if (p.hp !== 0) return `${id} is down with ${p.hp} hp`;
      if (p.statuses.length || p.tempMods.length || p.energy !== 0) return `${id} is down with statuses, temporary mods or energy`;
    } else if (s.status === 'playing' && p.hp <= 0) return `${id} at 0 hp while the run is playing`;
    for (const kind of ['weapon', 'armour', 'trinket'] as const) {
      const i = ps.equipped[kind];
      if (i !== null && !ps.slots[i]) return `equipped ${kind} of ${id} points at an empty slot`;
    }
    for (const it of ps.slots) if (it && !(it.count > 0)) return `item ${it.id} has count ${it.count}`;
    for (const r of world.resources ?? []) {
      const v = ps.resources[r.id];
      if (!(v >= 0 && v <= r.max)) return `resource ${r.id} of ${id} = ${v} outside 0..${r.max}`;
    }
  }
  const cd = s.area.exitCountdown;
  // 0 means "moving on now" and never outlives the party turn that reached it (party.ts)
  if (cd && s.status === 'playing' && !(cd.turnsLeft >= 1 && cd.turnsLeft <= s.partyRules.exitCountdownTurns)) return `exit countdown at ${cd.turnsLeft}`;
  if (cd && !s.party.includes(cd.by)) return `exit countdown started by ${cd.by}, who is not in the party`;
  if (!Number.isFinite(s.purse)) return `purse = ${s.purse}`;
  const taken = new Set<number>();
  for (const a of s.area.actors) {
    if (!Number.isFinite(a.hp) || !Number.isFinite(a.energy)) return `actor ${a.id} has a non-finite hp/energy`;
    if (a.hp <= 0) continue;
    if (a.pos.x < 0 || a.pos.y < 0 || a.pos.x >= map.width || a.pos.y >= map.height) return `actor ${a.id} out of bounds`;
    const k = a.pos.y * map.width + a.pos.x;
    if (taken.has(k)) return `two actors on ${a.pos.x},${a.pos.y}`;
    taken.add(k);
  }
  if (s.rng.length !== 4) return 'rng state has the wrong length';
  return null;
}

function actorLabel(world: WorldSpec, defId: string): string {
  if (defId === 'player') return world.player.name;
  return world.actors.find((a) => a.id === defId)?.name ?? defId;
}

/** plays one game; never throws (engine/bot errors become `crash`) */
export function runGame(world: WorldSpec, seed: number, botIn: Bot | BotName, opts: RunOptions = {}): SimResult {
  const bot = typeof botIn === 'string' ? botByName(botIn) : botIn;
  const maxTurns = opts.maxTurns ?? 3000;
  const stallSteps = opts.stallSteps ?? 400;
  const checkInv = opts.invariants ?? true;
  const env = { world, ...(opts.mapGenerator ? { mapGenerator: opts.mapGenerator } : {}) };
  const stats: SimStats = {
    kills: 0,
    damageDealt: 0,
    damageTaken: 0,
    itemsUsed: 0,
    areasCleared: 0,
    level: 1,
    hpLow: 1,
    talks: 0,
    persuades: 0,
    interacts: 0,
    pickups: 0,
    equips: 0,
    gmBatches: 0,
    gmSkipped: 0,
    invalidLegal: 0,
    turnsPerArea: [],
  };
  const res: SimResult = { world: world.meta.title, seed, bot: bot.name, difficulty: opts.difficulty ?? 'normal', result: 'timeout', turns: 0, steps: 0, areaReached: 0, cause: '', stats, anomalies: [] };
  const mem = newMemory(seed);
  let s: GameState;
  try {
    s = createGame(world, { seed, ...(opts.difficulty ? { difficulty: opts.difficulty } : {}), ...(opts.mapGenerator ? { mapGenerator: opts.mapGenerator } : {}) });
    res.difficulty = s.difficulty ?? 'normal';
  } catch (e) {
    res.result = 'crash';
    res.cause = `engine: createGame threw: ${errText(e)}`;
    return res;
  }
  let lastKey = progressKey(s);
  const resPrev: Record<string, number> = { ...leadPlayer(s).resources };
  let lastProgress = 0;
  let freeStreak = 0;
  let gmArea = -1;
  let nextIdle = 150;
  let lastHurt: { sourceId?: string; damageType: string } | null = null;
  const finish = (r: SimOutcome, cause: string): SimResult => {
    res.result = r;
    res.cause = cause;
    res.turns = s.turn;
    res.areaReached = Math.max(res.areaReached, s.area.index);
    stats.kills = s.stats.kills;
    stats.damageDealt = s.stats.damageDealt;
    stats.damageTaken = s.stats.damageTaken;
    stats.itemsUsed = s.stats.itemsUsed;
    stats.areasCleared = s.stats.areasCleared;
    stats.level = leadPlayer(s).level;
    return res;
  };

  for (;;) {
    if (s.status === 'won') return finish('won', s.endReason ?? 'goal reached');
    if (s.status === 'lost') return finish('lost', lossCause(world, s, lastHurt));
    if (s.turn >= maxTurns) return finish('timeout', `turn cap ${maxTurns} reached in area ${s.area.index}`);

    // scripted GM moments
    if (opts.gm) {
      try {
        if (s.area.index !== gmArea && !leadPlayer(s).pendingChoice && !leadPlayer(s).pendingPerkChoice) {
          gmArea = s.area.index;
          s = applyGm(s, gmActionsForArea(world, s.area.index), env, stats);
        } else if (s.turn >= nextIdle && !leadPlayer(s).pendingChoice) {
          nextIdle = s.turn + 150;
          s = applyGm(s, gmIdleActions(s), env, stats);
        }
      } catch (e) {
        return finish('crash', `engine: applyGmActions threw: ${errText(e)}`);
      }
      if (s.status !== 'playing') continue;
    }

    let action: PlayerAction;
    try {
      action = bot.decide(s, world, mem);
    } catch (e) {
      return finish('crash', `bot: ${bot.name} threw: ${errText(e)}`);
    }
    let r;
    const areaBefore = s.area.index;
    try {
      r = opts.fast ? fastStep(s, action, world, opts.mapGenerator) : step(s, action, env);
    } catch (e) {
      return finish('crash', `engine: step(${JSON.stringify(action)}) threw: ${errText(e)}`);
    }
    res.steps++;
    const refused = r.events.find((e): e is Extract<GameEvent, { type: 'invalid' }> => e.type === 'invalid');
    mem.lastAction = action;
    mem.lastInvalid = refused ? refused.reason : null;
    if (refused) {
      stats.invalidLegal++;
      if (res.anomalies.length < 5) res.anomalies.push(`seed ${seed} turn ${s.turn}: legal action ${JSON.stringify(action)} refused (${refused.reason})`);
    } else {
      count(stats, action);
    }
    for (const e of r.events) {
      if (e.type === 'damaged' && e.actorId === leadPlayer(s).actorId) lastHurt = { sourceId: e.sourceId, damageType: e.damageType };
    }
    s = r.state;
    opts.onStep?.(s, action, r.events);
    if (s.area.index > res.areaReached) res.areaReached = s.area.index;
    if (r.tookTurn) {
      freeStreak = 0;
      stats.turnsPerArea[areaBefore] = (stats.turnsPerArea[areaBefore] ?? 0) + 1;
    } else if (++freeStreak > MAX_FREE_STREAK) {
      return finish('stuck', `free-action loop (${JSON.stringify(action)}) in area ${s.area.index}`);
    }
    const pa = s.area.actors.find((a) => a.id === leadPlayer(s).actorId);
    if (pa && pa.maxHp > 0) stats.hpLow = Math.min(stats.hpLow, Math.max(0, pa.hp) / pa.maxHp);
    if (checkInv) {
      const err = invariantError(world, s);
      if (err) {
        res.anomalies.push(`seed ${seed} turn ${s.turn}: ${err}`);
        return finish('crash', `invariant: ${err}`);
      }
    }
    const key = progressKey(s);
    // a rising custom resource (refilling oxygen on a moss tile…) counts as progress too
    let rising = false;
    for (const id of Object.keys(leadPlayer(s).resources)) {
      const v = leadPlayer(s).resources[id] ?? 0;
      if (v > (resPrev[id] ?? Infinity)) rising = true;
      resPrev[id] = v;
    }
    if (key !== lastKey || rising) {
      lastKey = key;
      lastProgress = res.steps;
    } else if (res.steps - lastProgress > stallSteps) {
      let why = 'no progress';
      try {
        why = s.area.index >= world.areas.length - 1 ? 'final area, goal not met' : (transitionBlocker(s, env) ?? 'way onward open');
      } catch {
        /* keep the default */
      }
      const stall = `no progress for ${stallSteps} actions in area ${s.area.index} (${why})`;
      // the random bot doesn't seek the goal: its stalls are wandering, not soft-locks
      return bot.name === 'random' ? finish('timeout', `wandering: ${stall}`) : finish('stuck', stall);
    }
  }
}

function applyGm(s: GameState, actions: Parameters<typeof applyGmActions>[1], env: { world: WorldSpec }, stats: SimStats): GameState {
  const r = applyGmActions(s, actions, env);
  stats.gmBatches++;
  stats.gmSkipped += r.events.filter((e) => e.type === 'gm_skipped').length;
  return r.state;
}

function count(stats: SimStats, a: PlayerAction): void {
  switch (a.type) {
    case 'talk':
      stats.talks++;
      break;
    case 'persuade':
      stats.persuades++;
      break;
    case 'interact':
      stats.interacts++;
      break;
    case 'pickup':
      stats.pickups++;
      break;
    case 'equip':
      stats.equips++;
      break;
    default:
      break;
  }
}

function lossCause(world: WorldSpec, s: GameState, lastHurt: { sourceId?: string; damageType: string } | null): string {
  const reason = s.endReason ?? 'lost';
  if (/ by /.test(reason)) {
    const m = / by (.+)$/.exec(reason);
    return m ? `killed by ${m[1]}` : reason;
  }
  if (reason === world.goal.summary) return 'lose condition';
  if (lastHurt) {
    if (lastHurt.sourceId) {
      if (lastHurt.sourceId === leadPlayer(s).actorId) return 'killed by own action';
      const src = s.area.actors.find((a) => a.id === lastHurt.sourceId);
      return `killed by ${src ? actorLabel(world, src.defId) : 'an unseen source'}`;
    }
    const dt = world.damageTypes.find((d) => d.id === lastHurt.damageType);
    return `killed by ${dt?.name ?? lastHurt.damageType} damage (no attacker)`;
  }
  return reason;
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const where = e.stack?.split('\n').slice(1, 3).map((l) => l.trim()).join(' / ') ?? '';
    return `${e.message}${where ? ` @ ${where}` : ''}`;
  }
  return String(e);
}

// ---------------------------------------------------------------------------
// Batches and summaries
// ---------------------------------------------------------------------------

export interface BatchOptions extends RunOptions {
  seeds: number[];
  bots: (Bot | BotName)[];
}

export function runMany(world: WorldSpec, opts: BatchOptions): SimResult[] {
  const out: SimResult[] = [];
  for (const b of opts.bots) for (const seed of opts.seeds) out.push(runGame(world, seed, b, opts));
  return out;
}

export interface BotSummary {
  bot: string;
  runs: number;
  won: number;
  lost: number;
  stuck: number;
  crash: number;
  timeout: number;
  winRate: number;
  avgTurns: number;
  avgTurnsWon: number;
  deathsByCause: Record<string, number>;
  stuckCauses: Record<string, number>;
  /** turn caps and (random bot) wandering stalls */
  timeoutCauses: Record<string, number>;
  crashCauses: Record<string, number>;
  /** area index → runs that ended there */
  areaHistogram: number[];
  avgKills: number;
  avgLevel: number;
  invalidLegal: number;
  /** seeds per outcome (for repros) */
  seeds: Record<SimOutcome, number[]>;
}

export function summarize(results: SimResult[], areaCount: number): BotSummary[] {
  const byBot = new Map<string, SimResult[]>();
  for (const r of results) {
    const list = byBot.get(r.bot) ?? [];
    list.push(r);
    byBot.set(r.bot, list);
  }
  const out: BotSummary[] = [];
  for (const [bot, list] of byBot) {
    const n = list.length;
    const c = (o: SimOutcome) => list.filter((r) => r.result === o).length;
    const won = list.filter((r) => r.result === 'won');
    const tally = (o: SimOutcome, norm: (s: string) => string): Record<string, number> => {
      const t: Record<string, number> = {};
      for (const r of list) if (r.result === o) t[norm(r.cause)] = (t[norm(r.cause)] ?? 0) + 1;
      return t;
    };
    const hist = Array.from({ length: Math.max(areaCount, 1) }, () => 0);
    for (const r of list) hist[Math.min(r.areaReached, hist.length - 1)]++;
    const seeds = { won: [], lost: [], stuck: [], crash: [], timeout: [] } as Record<SimOutcome, number[]>;
    for (const r of list) seeds[r.result].push(r.seed);
    out.push({
      bot,
      runs: n,
      won: won.length,
      lost: c('lost'),
      stuck: c('stuck'),
      crash: c('crash'),
      timeout: c('timeout'),
      winRate: n ? won.length / n : 0,
      avgTurns: n ? list.reduce((a, r) => a + r.turns, 0) / n : 0,
      avgTurnsWon: won.length ? won.reduce((a, r) => a + r.turns, 0) / won.length : 0,
      deathsByCause: tally('lost', (s) => s),
      stuckCauses: tally('stuck', (s) => s.replace(/\(\{.*\}\)/, '(…)')),
      timeoutCauses: tally('timeout', (s) => s),
      crashCauses: tally('crash', (s) => s.split(' @ ')[0]),
      areaHistogram: hist,
      avgKills: n ? list.reduce((a, r) => a + r.stats.kills, 0) / n : 0,
      avgLevel: n ? list.reduce((a, r) => a + r.stats.level, 0) / n : 0,
      invalidLegal: list.reduce((a, r) => a + r.stats.invalidLegal, 0),
      seeds,
    });
  }
  return out;
}

/**
 * Pools two summary lists (the same bots on disjoint seed sets) into one, as if summarize() had
 * seen both result sets. Bots present in only one list are kept as they are.
 */
export function mergeSummaries(a: BotSummary[], b: BotSummary[]): BotSummary[] {
  const out: BotSummary[] = [];
  const names = [...new Set([...a.map((s) => s.bot), ...b.map((s) => s.bot)])];
  const addRec = (x: Record<string, number>, y: Record<string, number>) => {
    const r: Record<string, number> = { ...x };
    for (const [k, v] of Object.entries(y)) r[k] = (r[k] ?? 0) + v;
    return r;
  };
  for (const bot of names) {
    const x = a.find((s) => s.bot === bot);
    const y = b.find((s) => s.bot === bot);
    if (!x || !y) {
      out.push(structuredClone((x ?? y)!));
      continue;
    }
    const runs = x.runs + y.runs;
    const won = x.won + y.won;
    const wavg = (fx: number, nx: number, fy: number, ny: number) => (nx + ny ? (fx * nx + fy * ny) / (nx + ny) : 0);
    const hist = Array.from({ length: Math.max(x.areaHistogram.length, y.areaHistogram.length) }, (_, i) => (x.areaHistogram[i] ?? 0) + (y.areaHistogram[i] ?? 0));
    const seeds = {} as Record<SimOutcome, number[]>;
    for (const o of ['won', 'lost', 'stuck', 'crash', 'timeout'] as SimOutcome[]) seeds[o] = [...(x.seeds[o] ?? []), ...(y.seeds[o] ?? [])];
    out.push({
      bot,
      runs,
      won,
      lost: x.lost + y.lost,
      stuck: x.stuck + y.stuck,
      crash: x.crash + y.crash,
      timeout: x.timeout + y.timeout,
      winRate: runs ? won / runs : 0,
      avgTurns: wavg(x.avgTurns, x.runs, y.avgTurns, y.runs),
      avgTurnsWon: wavg(x.avgTurnsWon, x.won, y.avgTurnsWon, y.won),
      deathsByCause: addRec(x.deathsByCause, y.deathsByCause),
      stuckCauses: addRec(x.stuckCauses, y.stuckCauses),
      timeoutCauses: addRec(x.timeoutCauses, y.timeoutCauses),
      crashCauses: addRec(x.crashCauses, y.crashCauses),
      areaHistogram: hist,
      avgKills: wavg(x.avgKills, x.runs, y.avgKills, y.runs),
      avgLevel: wavg(x.avgLevel, x.runs, y.avgLevel, y.runs),
      invalidLegal: x.invalidLegal + y.invalidLegal,
      seeds,
    });
  }
  return out;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** a plain-text table for the CLI and reports */
export function formatSummary(title: string, sums: BotSummary[]): string {
  const lines: string[] = [];
  lines.push(`== ${title}`);
  lines.push('bot        runs   won  lost stuck crash  t/o  avgTurns  wonTurns  kills  lvl  areas reached (0..n)');
  for (const s of sums) {
    lines.push(
      [
        s.bot.padEnd(10),
        String(s.runs).padStart(4),
        pct(s.winRate).padStart(5),
        pct(s.lost / s.runs).padStart(5),
        pct(s.stuck / s.runs).padStart(5),
        pct(s.crash / s.runs).padStart(5),
        pct(s.timeout / s.runs).padStart(5),
        s.avgTurns.toFixed(0).padStart(9),
        s.avgTurnsWon.toFixed(0).padStart(9),
        s.avgKills.toFixed(1).padStart(6),
        s.avgLevel.toFixed(1).padStart(4),
        '  ' + s.areaHistogram.join(' / '),
      ].join(' '),
    );
  }
  for (const s of sums) {
    const top = (t: Record<string, number>) =>
      Object.entries(t)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${v}× ${k}`)
        .join('; ');
    if (s.lost) lines.push(`  ${s.bot} deaths: ${top(s.deathsByCause)}`);
    if (s.stuck) lines.push(`  ${s.bot} stuck: ${top(s.stuckCauses)} (seeds ${s.seeds.stuck.slice(0, 8).join(', ')})`);
    if (s.timeout) lines.push(`  ${s.bot} timed out: ${top(s.timeoutCauses)} (seeds ${s.seeds.timeout.slice(0, 8).join(', ')})`);
    if (s.crash) lines.push(`  ${s.bot} CRASH: ${top(s.crashCauses)} (seeds ${s.seeds.crash.slice(0, 8).join(', ')})`);
    if (s.invalidLegal) lines.push(`  ${s.bot} legal actions refused by step(): ${s.invalidLegal}`);
  }
  return lines.join('\n');
}
