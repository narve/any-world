/** Balance: static power budgets, rule impact, sim-backed verdicts and bounded auto-rebalancing. */
export { estimateRuleImpact, effectHarm, resourceDrainHarm, AREA_TURNS, type RuleImpact, type ResourceDrain } from './rules';
export {
  staticAnalysis,
  collectSources,
  infeasible,
  expectedActors,
  type StaticAnalysis,
  type AreaBudget,
  type HostileBudget,
  type ItemPower,
  type Sources,
} from './static';
export {
  analyseWorld,
  verdictFor,
  formatAnalysis,
  WIN_RATE_TARGETS,
  DIFFICULTIES,
  targetFor,
  MAX_STUCK_RATE,
  VERDICT_Z,
  wilsonInterval,
  seedList,
  type Difficulty,
  type Verdict,
  type VerdictResult,
  type BalanceReport,
  type AnalyseOptions,
} from './analyse';
export { autoRebalance, rebalance, feasibilityFixes, topKiller, scaleAmount, tooEasyFactor, bestHealingItem, type RebalanceResult } from './rebalance';
export { tuneWorld, tuneDistance, preferCandidate, confirmReport, TUNE_DEFAULT_SEEDS, type TuneOptions, type TuneResult, type TuneStep } from './tune';
