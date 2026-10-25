/**
 * analyseWorld: static power budget + bot simulations → a verdict with reasons and suggestions.
 *
 *   broken      — crashes, or soft-locks (bots stuck with the way onward closed)
 *   unwinnable  — the static check proves a goal/transition requirement can't be met
 *   too_hard    — the explorer bot's win rate is below the difficulty band, beyond sampling noise
 *                 (the whole 90% Wilson interval of the win rate lies below the band); or, when
 *                 the newbie bot was simulated at a gated difficulty, its win rate is below the
 *                 new-player floor beyond noise (gate.ts NEW_PLAYER_GATE)
 *   too_easy    — above the band, likewise beyond noise
 *   ok          — inside the band, no crashes, no soft-locks
 */
import type { WorldSpec } from '../../schema/world';
import { Difficulty } from '../../schema/gm';
import { runMany, summarize, type BotSummary, type RunOptions } from '../sim/run';
import type { BotName } from '../sim/bots';
import { staticAnalysis, type StaticAnalysis } from './static';

/**
 * Newbie-bot win-rate floors per difficulty (issues/M5-new-player-deaths.md): a new player wins
 * at least half the time on gentle and a quarter of the time on normal. Defined here (gate.ts
 * re-exports it) so the verdicts can use it without an import cycle.
 */
export const NEW_PLAYER_FLOORS: Partial<Record<Difficulty, number>> = { gentle: 0.5, normal: 0.25 };

export type { Difficulty };
/** the player's difficulty levels (shared with the client and the engine, src/schema/gm.ts) */
export const DIFFICULTIES: readonly Difficulty[] = Difficulty.options;
export type Verdict = 'ok' | 'too_hard' | 'too_easy' | 'unwinnable' | 'broken';

/**
 * Explorer-bot win-rate bands per difficulty. The explorer is a strong, thorough bot; since M5 the
 * player-facing guarantee is the newbie floor (NEW_PLAYER_FLOORS), and a world a new player wins
 * half the time on gentle is one the explorer wins nearly always — so the upper limits are
 * guard rails against absurdly easy worlds, not targets (DESIGN §2.5).
 */
export const WIN_RATE_TARGETS: Record<Difficulty, [number, number]> = {
  gentle: [0.5, 0.98],
  normal: [0.25, 0.85],
  hard: [0.12, 0.65],
  brutal: [0.05, 0.45],
};

/** the band for a difficulty; throws on anything that is not one of DIFFICULTIES */
export function targetFor(difficulty: string): [number, number] {
  if (!(DIFFICULTIES as readonly string[]).includes(difficulty)) throw new Error(`unknown difficulty "${difficulty}" (known: ${DIFFICULTIES.join(', ')})`);
  return WIN_RATE_TARGETS[difficulty as Difficulty];
}

/** z for the two-sided 90% interval used by the verdicts */
export const VERDICT_Z = 1.645;

/**
 * Wilson score interval of a win rate (`won` of `runs`), default 90%. Far better than p ± z·se at
 * the small samples and extreme rates balance runs produce (0/8 wins is not "exactly 0%").
 */
export function wilsonInterval(won: number, runs: number, z = VERDICT_Z): [number, number] {
  if (!(runs > 0)) return [0, 1];
  const p = Math.min(1, Math.max(0, won / runs));
  const z2 = z * z;
  const denom = 1 + z2 / runs;
  const centre = (p + z2 / (2 * runs)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / runs + z2 / (4 * runs * runs))) / denom;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

/** stuck share (non-random bots) above which a world counts as soft-locking */
export const MAX_STUCK_RATE = 0.1;

export interface VerdictResult {
  verdict: Verdict;
  reasons: string[];
  suggestions: string[];
  /** the win rate the verdict is based on (explorer, else the best non-random bot) */
  winRate: number;
  /** 90% Wilson interval of winRate ([0, 1] without simulations) */
  interval?: [number, number];
  /** runs the win rate is based on */
  runs?: number;
  target: [number, number];
}

export interface BalanceReport extends VerdictResult {
  world: string;
  difficulty: Difficulty;
  static: StaticAnalysis;
  sims: BotSummary[];
}

function topEntry(t: Record<string, number>): [string, number] | null {
  const e = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
  return e ?? null;
}

export function verdictFor(world: WorldSpec, sa: StaticAnalysis, sums: BotSummary[], difficulty: Difficulty = 'normal'): VerdictResult {
  const target = targetFor(difficulty);
  const reasons: string[] = [];
  const suggestions: string[] = [];
  const smart = sums.filter((s) => s.bot !== 'random');
  const explorer = sums.find((s) => s.bot === 'explorer');
  const basis = explorer ?? [...smart].sort((a, b) => b.winRate - a.winRate)[0];
  const winRate = basis ? basis.winRate : 0;
  const interval = basis ? wilsonInterval(basis.won, basis.runs) : ([0, 1] as [number, number]);
  const ci = `90% interval ${pct(interval[0])}–${pct(interval[1])} over ${basis?.runs ?? 0} runs`;
  const crashes = sums.reduce((n, s) => n + s.crash, 0);
  const runs = smart.reduce((n, s) => n + s.runs, 0);
  const stuck = smart.reduce((n, s) => n + s.stuck, 0);
  const stuckRate = runs ? stuck / runs : 0;

  let verdict: Verdict = 'ok';
  if (crashes) {
    verdict = 'broken';
    for (const s of sums) if (s.crash) reasons.push(`${s.crash}/${s.runs} ${s.bot} runs crashed: ${Object.keys(s.crashCauses).slice(0, 2).join('; ')} (seeds ${s.seeds.crash.slice(0, 5).join(', ')})`);
    suggestions.push('engine bug: reproduce with the listed seeds (npm run sim -- --world <file> --seed-start <seed> --seeds 1)');
  }
  if (sa.issues.length) {
    if (verdict === 'ok') verdict = 'unwinnable';
    reasons.push(...sa.issues);
    for (const i of sa.issues) {
      const item = /item "([^"]+)"/.exec(i)?.[1];
      const actor = /actor "([^"]+)"/.exec(i)?.[1];
      const flag = /flag "([^"]+)"/.exec(i)?.[1];
      if (item) suggestions.push(`place "${item}" with placedItems in the area that needs it (or earlier)`);
      if (actor) suggestions.push(`place "${actor}" with \`placed\` in the area that needs it`);
      if (flag) suggestions.push(`add an item, terrain interaction or on_death trigger that sets flag "${flag}"`);
    }
  }
  if (stuckRate > MAX_STUCK_RATE) {
    if (verdict === 'ok') verdict = 'broken';
    for (const s of smart) {
      if (!s.stuck) continue;
      const top = topEntry(s.stuckCauses);
      reasons.push(`${s.stuck}/${s.runs} ${s.bot} runs soft-locked${top ? `, mostly: ${top[0]}` : ''} (seeds ${s.seeds.stuck.slice(0, 5).join(', ')})`);
    }
    suggestions.push('check that transition requirements are reachable (placed items not walled off, required actors placed), or that the bots understand the requirement');
  }
  if (verdict === 'ok' && basis) {
    // only a band the whole interval misses counts: a point estimate outside it may be noise
    if (interval[1] < target[0]) {
      verdict = 'too_hard';
      reasons.push(`${basis.bot} wins ${pct(winRate)} (target ${pct(target[0])}–${pct(target[1])} for ${difficulty}; ${ci})`);
      const killer = topEntry(basis.deathsByCause);
      if (killer) {
        reasons.push(`most deaths: ${killer[0]} (${killer[1]}/${basis.lost})`);
        suggestions.push(`weaken the top killer (${killer[0].replace(/^killed by /, '')}): lower its damage or hp`);
      }
      const where = basis.areaHistogram.indexOf(Math.max(...basis.areaHistogram));
      if (where >= 0 && where < basis.areaHistogram.length - 1) reasons.push(`most runs end in area ${where + 1}`);
      suggestions.push('add healing consumables to spawn tables, or raise player hp');
    } else if (interval[0] > target[1]) {
      verdict = 'too_easy';
      reasons.push(`${basis.bot} wins ${pct(winRate)} (target ${pct(target[0])}–${pct(target[1])} for ${difficulty}; ${ci})`);
      suggestions.push('raise hostile hp/damage, add hostiles, or cut healing from spawn tables');
    } else if (winRate < target[0] || winRate > target[1]) {
      reasons.push(
        `${basis.bot} wins ${pct(winRate)} — ${winRate < target[0] ? 'below' : 'above'} ${pct(target[0])}–${pct(target[1])} for ${difficulty}, but within sampling noise (${ci}); run more seeds to tell`,
      );
    } else {
      reasons.push(`${basis.bot} wins ${pct(winRate)} — inside ${pct(target[0])}–${pct(target[1])} for ${difficulty}`);
    }
  }
  // the new-player floor: a newbie run that is clearly below it makes the world too hard, whatever
  // the explorer does (a world only a thorough player can win is not one a new player enjoys)
  const newbie = sums.find((s) => s.bot === 'newbie');
  const floor = NEW_PLAYER_FLOORS[difficulty];
  if (newbie && newbie.runs && floor !== undefined && (verdict === 'ok' || verdict === 'too_easy')) {
    const ni = wilsonInterval(newbie.won, newbie.runs);
    if (ni[1] < floor) {
      verdict = 'too_hard';
      reasons.push(`newbie wins ${pct(newbie.winRate)} (new-player floor ${pct(floor)} for ${difficulty}; 90% interval ${pct(ni[0])}–${pct(ni[1])} over ${newbie.runs} runs)`);
      const killer = topEntry(newbie.deathsByCause);
      if (killer) suggestions.push(`weaken what kills new players most (${killer[0].replace(/^killed by /, '')}): lower its damage or hp`);
      suggestions.push('fewer hostiles near the start, bigger heals');
    }
  }
  if (verdict === 'ok' && !basis) reasons.push('no simulations: static analysis only');
  // suggestions from the static budget — never ones that contradict a too_easy verdict
  if (verdict !== 'too_easy') {
    const risky = sa.areas.filter((a) => a.risk > 1);
    for (const a of risky) suggestions.push(`area ${a.index + 1} (${a.name}): add healing to its item table or thin out ${[...a.hostiles].sort((x, y) => y.damagePerFight * y.count - x.damagePerFight * x.count)[0]?.name ?? 'its hostiles'} (risk ${a.risk})`);
    for (const r of sa.rules) if (r.harmful && r.magnitude === 'major') suggestions.push(`soften rule "${r.id}" (${r.notes.join(', ')})`);
  }
  void world;
  return { verdict, reasons, suggestions: [...new Set(suggestions)], winRate, interval, runs: basis?.runs ?? 0, target };
}

export interface AnalyseOptions extends RunOptions {
  seeds?: number[] | number;
  bots?: BotName[];
  difficulty?: Difficulty;
}

/** a seed count n means seeds 1..n */
export function seedList(seeds: number[] | number | undefined, fallback: number): number[] {
  return Array.isArray(seeds) ? seeds : Array.from({ length: seeds ?? fallback }, (_, i) => i + 1);
}

/** static analysis + simulations + verdict (synchronous; for many seeds use tools/sim.ts) */
export function analyseWorld(world: WorldSpec, opts: AnalyseOptions = {}): BalanceReport {
  const seeds = seedList(opts.seeds, 20);
  const bots = opts.bots ?? ['explorer', 'cautious'];
  const difficulty = opts.difficulty ?? 'normal';
  targetFor(difficulty);
  const sa = staticAnalysis(world);
  // the games are played at the band they are judged against (engine difficulty scaling included)
  const results = seeds.length && bots.length ? runMany(world, { ...opts, difficulty, seeds, bots }) : [];
  const sims = summarize(results, world.areas.length);
  const v = verdictFor(world, sa, sims, difficulty);
  return { world: world.meta.title, difficulty, static: sa, sims, ...v };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** human-readable block for CLI output and reports */
export function formatAnalysis(sa: StaticAnalysis, v: VerdictResult): string {
  const lines: string[] = [];
  lines.push(`  verdict: ${v.verdict.toUpperCase()}`);
  for (const r of v.reasons) lines.push(`    - ${r}`);
  lines.push('  static budget (per area: level, hp, dmg/turn, expected hostiles, fight dmg + rule dmg vs healing → risk):');
  for (const a of sa.areas) {
    lines.push(
      `    ${a.index + 1}. ${a.name.slice(0, 32).padEnd(32)} L${a.playerLevel} hp ${a.playerHp} dpt ${a.playerDpt} | ${a.expectedHostiles} hostiles, ${a.fightDamage}+${a.ruleDamage} dmg vs ${a.healing} heal → risk ${a.risk}${a.bossRisk !== null ? `, boss ${a.bossRisk}` : ''}`,
    );
  }
  for (const r of sa.rules) if (r.magnitude !== 'none') lines.push(`    rule ${r.id}: ${r.hpPer100 > 0 ? '+' : ''}${r.hpPer100} hp/100 turns (${r.magnitude})`);
  for (const w of sa.warnings) lines.push(`    ! ${w}`);
  for (const s of v.suggestions) lines.push(`    → ${s}`);
  return lines.join('\n');
}
