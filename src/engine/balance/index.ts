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
  NEW_PLAYER_FLOORS,
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
export {
  autoRebalance,
  rebalance,
  feasibilityFixes,
  newPlayerFixes,
  playerReach,
  hostileReach,
  FIRST_AREA_MAX_HOSTILES,
  FIRST_AREA_MAX_GUARANTEED,
  MIN_HEAL_SHARE,
  topKiller,
  scaleAmount,
  tooEasyFactor,
  bestHealingItem,
  type RebalanceResult,
} from './rebalance';
export { NEW_PLAYER_GATE, GATE_BOT, newPlayerGate, gateFromResults, gateLevel, formatGate, type GateLevel, type GateReport, type GateOptions } from './gate';
export { tuneWorld, tuneDistance, preferCandidate, confirmReport, TUNE_DEFAULT_SEEDS, type TuneOptions, type TuneResult, type TuneStep } from './tune';
