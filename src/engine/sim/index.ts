/** Simulation: bots, the game runner and batch summaries (see tools/sim.ts). */
export { BOT_NAMES, DEFEND_RANGE, type Bot, type BotName, type BotMemory, botByName, newMemory, botPower } from './bots';
export {
  type SimOutcome,
  type RunOptions,
  type SimStats,
  type SimResult,
  type BatchOptions,
  type BotSummary,
  runGame,
  runMany,
  summarize,
  formatSummary,
  invariantError,
  mergeSummaries,
} from './run';
export { gmActionsForArea, gmIdleActions, simRule, SIM_RULE_ID } from './gm-script';
export { botCtx, fastLegal, itemProfile, type ItemProfile } from './view';
export { fastStep, fastStepTurn } from './fast';
export {
  runParty,
  summarizeParty,
  formatPartySummary,
  timeStats,
  partyBots,
  MAX_FREE_PER_TURN,
  type PartyResult,
  type PartyRunOptions,
  type PartySummary,
  type PartyTiming,
  type PartyTimingSummary,
  type PartyTurnInfo,
  type TimeStats,
} from './party';
