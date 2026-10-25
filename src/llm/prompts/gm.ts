/**
 * Live game-master prompt (DESIGN §4.3). One request per GM hook: the system prompt carries the
 * GM's role, discipline (moderate presence, budget, add_rule limits, a ceiling on help), the
 * world's persona and the language rule; the user message carries the current situation and what
 * this hook asks for.
 */
import type { CompletionRequest } from '../types';
import type { WorldSpec } from '../../schema/world';
import { GM_BUDGET_PER_AREA, MAX_ACTIVE_RULES, MAX_GM_RULES_PER_AREA, type Difficulty, type GmHook } from '../../schema/gm';
import type { GameState, LogMessage } from '../../engine/types';
import { GM_SCHEMA_DOC, SCHEMA_NOTATION } from './world-schema';
import { JSON_ONLY, languageInstruction } from './common';
import { costTable, gmPersona, gmSituation, worldSummary } from './gm-summary';
import { GM_HARMFUL_STATUS_TURNS, protectedGoalLine } from '../goal-refs';

/** at most this many helpful GM actions per area (gifts, xp, money, healing, helpful rules) */
export const HELPFUL_CEILING: Record<Difficulty, number> = { gentle: 3, normal: 2, hard: 1, brutal: 1 };

export const GM_MAX_TOKENS = 1500;
export const GM_TEMPERATURE = 0.9;
export const GM_SCHEMA_NAME = 'gm_response';

export interface GmHookInfo {
  hook: GmHook;
  area: number;
  turn: number;
  detail?: { regionId?: number; regionName?: string; actorId?: string; questId?: string; level?: number; reason?: string };
}

export interface GmPromptInput extends GmHookInfo {
  world: WorldSpec;
  state: GameState;
  difficulty: Difficulty;
  weirdness?: number;
  recentLog?: LogMessage[];
  areaEnteredTurn?: number;
  /** helpful actions this director already issued in this area (for the ceiling) */
  helpfulUsed?: number;
}

const ROLE = `You are the live game master of one run of AnyWorld, a turn-based roguelike. The world was invented at the start of the run; you narrate it, voice its characters and now and then change the course of play with GM actions taken from a whitelist. The engine applies your actions, checks every reference and refuses anything over budget or beyond the limits.`;

function discipline(difficulty: Difficulty, world?: WorldSpec): string {
  const ceiling = HELPFUL_CEILING[difficulty];
  const goal = world ? protectedGoalLine(world) : '';
  return `GM DISCIPLINE
- Moderate presence: the player should notice you, not drown in you. Narrate arrivals and key discoveries in 1–3 vivid sentences; about one event per area; often the right answer is {"actions":[]}.
- Never decide for the player, never describe their feelings, never summarise mechanics they can see. Speak in the world's voice, in the present tense.
- Budget: each area has ${GM_BUDGET_PER_AREA} points; costs per action: ${costTable()}. offer_choice also reserves its most expensive option. Stay within the budget shown in the situation.
- Only reference ids listed in the situation or the world facts: actor ids for spawn and summon (never unique characters); for say / trade / change_faction prefer the def id of an actor in this area (the id in [brackets]: it stays valid when the moment is replayed in another run), and use an instance id (like "a12") only to pick one of several actors of the same kind; item ids for give_item / place_item / reveal_item; rule ids for remove_rule.
- Unidentified items appear under their appearance, with their true nature in brackets for you only: never name or hint at it to the player.
- Allowed actions per hook: intro, death and victory take only narrate, say and mood (anything else is refused); every other hook may use any action within budget.
- New rules (add_rule) are rare and dramatic: only on area_enter (not the first area), milestone or boss_seen; at most ${MAX_GM_RULES_PER_AREA} per area and ${MAX_ACTIVE_RULES} active in total; announce it in-story in "reason" and give it a plain player-facing description. It must fit the story so far. Harsh rules need a counterweight on ${difficulty === 'gentle' ? 'this gentle run (keep the net effect about neutral)' : 'easier difficulties'}; on ${difficulty} the engine refuses rules that are too harmful. A rule's triggers act on or around the player and may not hurt or hinder their foes (that is a one-off effect). Never write to flags or counters the goal depends on.${goal ? `\n${goal}` : ''}
- Help has a ceiling: at most ${ceiling} helpful action${ceiling === 1 ? '' : 's'} per area on ${difficulty} (give_item / place_item of useful items, grant_xp, positive currency, healing or buffs, damaging or weakening enemies, turning a hostile friendly, spawning an ally, quests with a reward, helpful rules, removing a harmful rule). The situation says how much of it this area has used. Match every gift with a cost, a risk or a threat; do not rescue the player from every scrape.
- Harmful statuses from your effects last at most ${GM_HARMFUL_STATUS_TURNS} turns.
- Threats are fair: spawn at most 1–2 ordinary hostiles at a time, "random" or "exit" rather than next to a wounded player, and not when the player is below half health.
- Keep the world's facts straight: do not contradict the premise, the goal, the area description or what NPCs know.`;
}

/** what each hook asks for */
export const HOOK_BRIEF: Record<GmHook, string> = {
  intro: 'The run starts. Narrate the opening in 2–4 sentences: where the player is, what is at stake, a hook to pull them in. Only narrate, say and mood.',
  area_enter:
    'The player has just arrived in a new area. Narrate the arrival in 1–3 sentences (what they sense first, one concrete detail). You may set the mood. If the story has earned it, this is one of the few moments to add a rule (add_rule).',
  region_discovered:
    'The player has discovered a new part of the area. Usually say nothing ({"actions":[]}); add one short line only if the place is notable, or let a visible NPC say something in character.',
  low_hp:
    'The player is badly hurt. At most one short, tense line. Do not heal them unless the difficulty is gentle and the help ceiling allows a small mercy; never add threats now.',
  boss_seen:
    'A unique character (see detail) has come into view for the first time. Announce them: a narrate line and/or a line they say themselves (say with their def id); the boss mood fits. Do not spawn extra enemies.',
  milestone: 'A milestone (see detail: level up, quest done, unique defeated). Acknowledge it briefly; a small reward, a new quest (start_quest) or a rule change may follow if it serves the story.',
  idle:
    'Nothing has happened for a while. If this area has not had its event yet (no flag "gm_event_area_<area>"), make one now: an encounter, a find, a choice (offer_choice), a quest, an NPC moment; then set that flag with set_flag. Otherwise, usually nothing.',
  death: 'The player has lost the run. Write a short epitaph (narrate, 1–3 sentences) that remembers how this run went (the log shows what brought them down). Only narrate, say and mood.',
  victory: 'The player has won. Write a short closing narration (1–3 sentences) that pays off the run and the route they took. Only narrate, say and mood.',
};

/** the system prompt for one world (stable across hooks, so providers can cache it) */
export function gmSystemPrompt(world: WorldSpec, difficulty: Difficulty): string {
  return [
    ROLE,
    `THIS WORLD'S GAME MASTER\n${gmPersona(world)}`,
    languageInstruction(world.meta.language ?? 'en'),
    discipline(difficulty, world),
    `WORLD FACTS\n${worldSummary(world)}`,
    `OUTPUT FORMAT (TypeScript-style; the root value is a GmResponse)\n${SCHEMA_NOTATION}\n\n${GM_SCHEMA_DOC}`,
    JSON_ONLY,
  ].join('\n\n');
}

export function gmUserMessage(input: GmPromptInput): string {
  const ceiling = HELPFUL_CEILING[input.difficulty];
  const used = input.helpfulUsed ?? 0;
  const help = `HELP USED this area: ${used} of ${ceiling}${used >= ceiling ? ' (used up: add challenge, story or nothing instead)' : ''}`;
  const detail = input.detail ? Object.entries(input.detail).map(([k, v]) => `${k}=${String(v)}`).join(', ') : '';
  return [
    gmSituation(input),
    help,
    `HOOK: ${input.hook} (area ${input.area}, turn ${input.turn})${detail ? `; detail: ${detail}` : ''}`,
    HOOK_BRIEF[input.hook],
    'Reply with the GmResponse JSON.',
  ].join('\n\n');
}

export function buildGmPrompt(input: GmPromptInput): { system: string; user: string } {
  return { system: gmSystemPrompt(input.world, input.difficulty), user: gmUserMessage(input) };
}

export function gmRequest(input: GmPromptInput, purpose: string, extra: Partial<CompletionRequest> = {}): CompletionRequest {
  const p = buildGmPrompt(input);
  return {
    system: p.system,
    messages: [{ role: 'user', content: p.user }],
    schemaName: GM_SCHEMA_NAME,
    maxTokens: GM_MAX_TOKENS,
    temperature: GM_TEMPERATURE,
    purpose,
    ...extra,
  };
}
