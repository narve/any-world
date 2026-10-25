/**
 * The new-player gate (issues/M5-new-player-deaths.md): every demo world has to be winnable by a
 * new player, measured with the `newbie` sim bot (fights only what comes close, heals at 35%, never
 * tries unknown items). The explorer-band verdicts in analyse.ts judge a world against a strong,
 * thorough bot; this gate judges it against a weak one, at the two levels a new player picks:
 *
 *   gentle — the newbie bot wins at least 50% of its runs
 *   normal — the newbie bot wins at least 25% of its runs
 *
 * A point estimate below the floor fails the gate (the gate is a floor, not a band, so it does not
 * wait for the whole Wilson interval to miss it); the interval is reported so a borderline miss can
 * be told apart from a clear one.
 */
import type { WorldSpec } from '../../schema/world';
import { runMany, summarize, type BotSummary, type RunOptions, type SimResult } from '../sim/run';
import { topKiller } from './rebalance';
import { NEW_PLAYER_FLOORS, seedList, wilsonInterval, type Difficulty } from './analyse';

/** the bot the gate is measured with */
export const GATE_BOT = 'newbie' as const;

/** minimum newbie win rate per gated difficulty */
export const NEW_PLAYER_GATE: Partial<Record<Difficulty, number>> = NEW_PLAYER_FLOORS;

export interface GateLevel {
  difficulty: Difficulty;
  floor: number;
  runs: number;
  won: number;
  winRate: number;
  interval: [number, number];
  pass: boolean;
  /** share of runs that ended in the first area */
  firstAreaDeaths: number;
  /** the hostile behind most newbie deaths, if any */
  topKiller?: string;
}

export interface GateReport {
  world: string;
  pass: boolean;
  levels: GateLevel[];
}

/** judges newbie summaries (one per gated difficulty) against the floors */
export function gateLevel(world: WorldSpec, difficulty: Difficulty, sum: BotSummary | undefined): GateLevel {
  const floor = NEW_PLAYER_GATE[difficulty] ?? 0;
  const runs = sum?.runs ?? 0;
  const won = sum?.won ?? 0;
  const winRate = runs ? won / runs : 0;
  const killer = sum ? topKiller(world, sum.deathsByCause) : undefined;
  return {
    difficulty,
    floor,
    runs,
    won,
    winRate,
    interval: wilsonInterval(won, runs),
    pass: runs > 0 && winRate >= floor,
    firstAreaDeaths: runs && sum ? (sum.areaHistogram[0] ?? 0) / runs : 0,
    ...(killer ? { topKiller: killer.name } : {}),
  };
}

/** the gate verdict from finished newbie runs (`results` may mix difficulties; other bots are ignored) */
export function gateFromResults(world: WorldSpec, results: SimResult[]): GateReport {
  const levels: GateLevel[] = [];
  for (const d of Object.keys(NEW_PLAYER_GATE) as Difficulty[]) {
    const rs = results.filter((r) => r.bot === GATE_BOT && r.difficulty === d);
    const sum = summarize(rs, world.areas.length)[0];
    levels.push(gateLevel(world, d, sum));
  }
  return { world: world.meta.title, pass: levels.every((l) => l.pass), levels };
}

export interface GateOptions extends Omit<RunOptions, 'difficulty'> {
  /** seed count (1..n) or list, default 40 */
  seeds?: number[] | number;
}

/** runs the newbie bot at every gated difficulty (synchronous; tools/sim.ts --gate runs it in parallel) */
export function newPlayerGate(world: WorldSpec, opts: GateOptions = {}): GateReport {
  const seeds = seedList(opts.seeds, 40);
  const results: SimResult[] = [];
  for (const d of Object.keys(NEW_PLAYER_GATE) as Difficulty[]) results.push(...runMany(world, { ...opts, difficulty: d, seeds, bots: [GATE_BOT] }));
  return gateFromResults(world, results);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatGate(g: GateReport): string {
  const lines = [`  new-player gate: ${g.pass ? 'PASS' : 'FAIL'}`];
  for (const l of g.levels)
    lines.push(
      `    ${l.difficulty.padEnd(7)} newbie ${pct(l.winRate).padStart(4)} (floor ${pct(l.floor)}, 90% ${pct(l.interval[0])}–${pct(l.interval[1])}, ${l.runs} runs) ${l.pass ? 'ok' : 'FAIL'}` +
        ` | ${pct(l.firstAreaDeaths)} end in area 1${l.topKiller ? `, top killer ${l.topKiller}` : ''}`,
    );
  return lines.join('\n');
}
