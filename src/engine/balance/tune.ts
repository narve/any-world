/**
 * tuneWorld: the generation pipeline's balance loop — analyse (static + bots), and while the
 * verdict is too_hard / too_easy / unwinnable, apply autoRebalance and analyse again, up to
 * `rounds` times. Keeps the best world seen (see `tuneDistance`; later rounds win ties, never one
 * that crashed), and always keeps the feasibility fixes (placed goal / lock items and actors).
 *
 * Sampling noise (issues/M2-sim-tune-sampling-noise.md): bot win rates over a few dozen seeds swing
 * by ±15 points, so
 *   - the verdicts are confidence-aware (analyse.ts: too_hard / too_easy only when the whole 90%
 *     Wilson interval misses the band),
 *   - the default sample is TUNE_DEFAULT_SEEDS seeds, not analyseWorld's 20,
 *   - a world is only changed after its too_hard / too_easy verdict held on a second, fresh block of
 *     seeds, and a rebalanced candidate is only accepted as the best world after it, too, was
 *     re-checked on fresh seeds (pooled with the first block),
 *   - among worlds inside the band, one whose interval covers the band centre beats one on the edge.
 */
import type { WorldSpec } from '../../schema/world';
import { analyseWorld, seedList, verdictFor, wilsonInterval, type AnalyseOptions, type BalanceReport, type Verdict } from './analyse';
import { mergeSummaries } from '../sim/run';
import { feasibilityFixes, rebalance } from './rebalance';

/** seeds per analysis in tuneWorld when opts.seeds is not given */
export const TUNE_DEFAULT_SEEDS = 60;

export interface TuneOptions extends AnalyseOptions {
  /** rebalance rounds, default 3 */
  rounds?: number;
  /** re-check verdicts and candidates on fresh seeds before acting on them, default true */
  confirm?: boolean;
}

export interface TuneStep {
  round: number;
  verdict: Verdict;
  winRate: number;
  /** runs the verdict rests on (more than the seed count after a fresh-seed re-check) */
  runs?: number;
  changes: string[];
}

export interface TuneResult {
  world: WorldSpec;
  report: BalanceReport;
  history: TuneStep[];
}

/** mean depth reached by the verdict's basis bot, 0 (died in the first area) … 1 (last area) */
function basisOf(r: BalanceReport) {
  const smart = r.sims.filter((s) => s.bot !== 'random');
  return smart.find((s) => s.bot === 'explorer') ?? [...smart].sort((a, b) => b.winRate - a.winRate)[0];
}

function depth(r: BalanceReport): number {
  const basis = basisOf(r);
  if (!basis || !basis.runs) return 0;
  const h = basis.areaHistogram;
  if (h.length <= 1) return 1;
  const sum = h.reduce((n, c, i) => n + c * i, 0);
  return sum / basis.runs / (h.length - 1);
}

/**
 * How far a report is from a good world (lower is better). The verdict class dominates
 * (broken 100+, unwinnable 50+, too_hard / too_easy 1+, ok below 0.1), and inside a class finer
 * signals rank worlds: fewer static issues, fewer crashes / soft-locks, and — for worlds that are
 * too hard — a higher win rate and deeper runs, so progress that does not yet change the verdict
 * still counts. Among ok worlds, one whose win-rate interval covers the band centre scores 0 and
 * one that only reaches the band edge scores by how far its interval stays from the centre.
 */
export function tuneDistance(r: BalanceReport): number {
  const smart = r.sims.filter((s) => s.bot !== 'random');
  const runs = smart.reduce((n, s) => n + s.runs, 0) || 1;
  const bad = r.sims.reduce((n, s) => n + s.crash, 0) / Math.max(1, r.sims.reduce((n, s) => n + s.runs, 0)) + smart.reduce((n, s) => n + s.stuck, 0) / runs;
  const [lo, hi] = r.target;
  const band = r.winRate < lo ? lo - r.winRate : r.winRate > hi ? r.winRate - hi : 0;
  // depth only breaks ties among worlds that are too hard (0.05 < the smallest win-rate step that matters)
  const shortfall = r.winRate < lo ? 0.05 * (1 - depth(r)) : 0;
  const base = band + shortfall;
  if (r.verdict === 'broken') return 100 + 10 * bad + base;
  if (r.verdict === 'unwinnable') return 50 + 5 * r.static.issues.length + base;
  if (r.verdict === 'ok') {
    const basis = basisOf(r);
    const [a, b] = r.interval ?? (basis ? wilsonInterval(basis.won, basis.runs) : [r.winRate, r.winRate]);
    const centre = (lo + hi) / 2;
    const off = centre < a ? a - centre : centre > b ? centre - b : 0;
    return 0.1 * off;
  }
  return 1 + base;
}

/**
 * Re-checks a report on `seeds` (fresh ones, disjoint from the report's) and returns the verdict on
 * both seed blocks pooled — the same world judged on twice the evidence.
 */
export function confirmReport(world: WorldSpec, report: BalanceReport, opts: AnalyseOptions, seeds: number[]): BalanceReport {
  if (!seeds.length) return report;
  const extra = analyseWorld(world, { ...opts, seeds, difficulty: report.difficulty });
  const sims = mergeSummaries(report.sims, extra.sims);
  return { ...report, sims, ...verdictFor(world, report.static, sims, report.difficulty) };
}

/**
 * Whether a candidate report should replace the best one so far. Lower tuneDistance wins, later
 * rounds win ties — and between two too_easy worlds the later one always wins: too_easy rounds only
 * ever make hostiles stronger and healing rarer, so a later world that is still too easy is at
 * least as close in expectation, and the win-rate difference between them is mostly sampling noise
 * (issues/M2-sim-tune-cannot-fix-too-easy.md: noise picked the least corrected round 1 over 2 and 3).
 * The same holds between two too_hard worlds through the depth tiebreak in tuneDistance.
 */
export function preferCandidate(candidate: BalanceReport, best: BalanceReport): boolean {
  if (candidate.verdict === 'too_easy' && best.verdict === 'too_easy') return true;
  return tuneDistance(candidate) <= tuneDistance(best);
}

export function tuneWorld(world: WorldSpec, opts: TuneOptions = {}): TuneResult {
  const rounds = opts.rounds ?? 3;
  const confirm = opts.confirm ?? true;
  const seeds = seedList(opts.seeds, TUNE_DEFAULT_SEEDS);
  const aopts: AnalyseOptions = { ...opts, seeds };
  // fresh seed blocks follow the given seeds, never overlapping them or each other
  let next = Math.max(0, ...seeds) + 1;
  const fresh = (): number[] => {
    const out = seeds.map((_, i) => next + i);
    next += seeds.length;
    return out;
  };
  const sampled = (v: Verdict) => v === 'too_hard' || v === 'too_easy';
  const step = (round: number, r: BalanceReport, changes: string[]): TuneStep => ({ round, verdict: r.verdict, winRate: r.winRate, runs: r.runs, changes });

  let cur = world;
  let report = analyseWorld(cur, aopts);
  // never change a world on one seed window's say-so
  if (confirm && sampled(report.verdict)) report = confirmReport(cur, report, aopts, fresh());
  const history: TuneStep[] = [step(0, report, [])];
  let best = { world: cur, report };
  for (let round = 1; round <= rounds; round++) {
    if (report.verdict === 'ok' || report.verdict === 'broken') break;
    const res = rebalance(cur, report);
    if (!res.valid || res.world === cur) {
      history.push(step(round, report, res.changes));
      break;
    }
    cur = res.world;
    report = analyseWorld(cur, aopts);
    // a candidate that looks at least as good as the best is re-checked on fresh seeds before it
    // can replace it: a lucky seed window must not pick the world
    if (confirm && preferCandidate(report, best.report)) report = confirmReport(cur, report, aopts, fresh());
    history.push(step(round, report, res.changes));
    // later rounds win ties: the same distance after more fixes is not worse
    if (preferCandidate(report, best.report)) best = { world: cur, report };
  }
  // feasibility fixes are always kept, even on a world chosen for its win rate
  if (best.report.static.issues.length) {
    const fix = feasibilityFixes(best.world);
    if (fix.valid && fix.world !== best.world) {
      const r = analyseWorld(fix.world, aopts);
      history.push(step(history.length, r, fix.changes));
      if (r.verdict !== 'broken' || best.report.verdict === 'broken') best = { world: fix.world, report: r };
    }
  }
  return { world: best.world, report: best.report, history };
}
