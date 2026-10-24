/**
 * Log lines for LLM prompts in the WORLD's language (DESIGN §7b). The engine writes its log lines in
 * English with a catalog key + params (LogMessage.key/params); the UI renders them in the UI
 * language, but the game master and NPC dialogue prompts should see them in the language the world
 * is written in, or an nb world's prompt mixes in English lines and nudges the model to answer in
 * English. GM/NPC lines and lines without a key are already world text and stay as they are.
 */
import type { GameState, LogMessage } from '../../engine/types';
import type { WorldSpec } from '../../schema/world';
import { catalog, normalizeLanguage } from './index';
import { formatMessage } from './message-format';

/** one log line's text in `lang` (its own text when the catalog has no template for its key) */
export function logTextIn(m: LogMessage, lang: string, hpName?: string): string {
  if (m.kind === 'gm' || m.kind === 'npc' || !m.key) return m.text;
  const tpl = catalog(lang)?.[m.key];
  if (tpl === undefined) return m.text;
  return formatMessage(tpl, { ...(m.params ?? {}), ...(hpName ? { hp: hpName } : {}) }, lang);
}

/** the log rendered in the world's language (the same array for English worlds or unknown languages) */
export function promptLog(log: readonly LogMessage[], world: Pick<WorldSpec, 'meta' | 'vocabulary'>): LogMessage[] {
  const lang = normalizeLanguage(world.meta.language || 'en');
  if (lang === 'en' || !catalog(lang)) return log as LogMessage[];
  const hp = world.vocabulary.stats.hp.name;
  return log.map((m) => {
    const text = logTextIn(m, lang, hp);
    return text === m.text ? m : { ...m, text };
  });
}

/** a shallow snapshot of `state` whose log reads in the world's language (for prompt building only) */
export function withPromptLog(state: GameState, world: Pick<WorldSpec, 'meta' | 'vocabulary'>): GameState {
  const log = promptLog(state.log, world);
  return log === state.log ? state : { ...state, log };
}
