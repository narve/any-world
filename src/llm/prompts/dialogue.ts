/**
 * NPC dialogue prompt: one in-character turn of a conversation (DESIGN §3.1 "NPCs and dialogue",
 * §4.3). The model answers as the NPC, offers up to 3 short player replies, and may attach a few
 * GM actions (trade, a gift from the NPC's stock, a quest, a faction change) that the engine checks
 * and budgets like any GM action.
 */
import type { CompletionRequest } from '../types';
import type { ActorDef, WorldSpec } from '../../schema/world';
import type { Difficulty } from '../../schema/gm';
import type { ActorInstance, GameState } from '../../engine/types';
import { DIALOGUE_SCHEMA_DOC, SCHEMA_NOTATION } from './world-schema';
import { JSON_ONLY, languageInstruction } from './common';
import { gmPersona, gmSituation, worldSummary, knownItemName } from './gm-summary';
import { HELPFUL_CEILING } from './gm';

export const DIALOGUE_MAX_TOKENS = 1200;
export const DIALOGUE_TEMPERATURE = 0.9;
export const DIALOGUE_SCHEMA_NAME = 'dialogue_response';
/** turns of history kept in the prompt */
export const DIALOGUE_HISTORY_TURNS = 12;

export interface DialogueLine {
  speaker: 'npc' | 'player';
  text: string;
}

export interface DialoguePromptInput {
  world: WorldSpec;
  state: GameState;
  /** the NPC's actor instance id in state.area.actors */
  npcId: string;
  difficulty: Difficulty;
  /** the conversation so far, oldest first */
  history?: DialogueLine[];
  /** what the player just said (empty on the opening turn) */
  playerLine?: string;
  helpfulUsed?: number;
}

export function npcOf(world: WorldSpec, state: GameState, npcId: string): { inst: ActorInstance; def: ActorDef } | null {
  const inst = state.area.actors.find((a) => a.id === npcId);
  if (!inst) return null;
  const def = world.actors.find((d) => d.id === inst.defId);
  return def ? { inst, def } : null;
}

const ROLE = `You voice one non-player character in a run of AnyWorld, a turn-based roguelike. Stay in character: speak as they would, with their knowledge, wants and secrets. You may also attach a few GM actions the conversation causes; the engine checks and budgets them.`;

const RULES = `DIALOGUE RULES
- reply: 1–4 sentences of the NPC's own speech (no stage directions in brackets, no narration of the player's actions). Keep it specific to this world and this moment.
- The game builds the player's buttons itself from the NPC's role: buy and sell with a trader, the healer's help, the quest giver's offer, persuade, ask what they know, goodbye. Your reply is spoken over those buttons, so you never need to list goods or prices; refer to them in character if it fits.
- options: up to 3 short things the player could say next (≤ 12 words each), in the player's voice, each leading somewhere different. They are kept as the conversation's hints (the buttons above stay the player's choices), so keep them brief. Leave it empty when the NPC ends the talk.
- actions (optional, max 3): give_item from their stock when earned, start_quest with a reachable completion condition, change_faction, set_flag, reveal_item, say/narrate for side remarks. Do not use trade: a trader's goods are already on the buttons, and a trade inside a conversation is ignored. Use the NPC's def id (in [brackets]) for say and change_faction. Never spawn enemies from a friendly chat unless the NPC is hostile in intent. Helpful actions count against the area's help ceiling.
- Secrets are revealed only when earned (persuasion, a good reason, a fair trade). Wants drive their offers.
- end: true when the NPC ends the conversation (then options is empty).`;

export function dialogueSystemPrompt(world: WorldSpec, difficulty: Difficulty): string {
  return [
    ROLE,
    `THE WORLD'S GAME MASTER (tone reference)\n${gmPersona(world)}`,
    languageInstruction(world.meta.language ?? 'en'),
    RULES,
    `Help ceiling on ${difficulty}: at most ${HELPFUL_CEILING[difficulty]} helpful actions per area across all GM moments and conversations.`,
    `WORLD FACTS\n${worldSummary(world)}`,
    `OUTPUT FORMAT (TypeScript-style; the root value is a DialogueResponse)\n${SCHEMA_NOTATION}\n\n${DIALOGUE_SCHEMA_DOC}`,
    JSON_ONLY,
  ].join('\n\n');
}

function npcBlock(world: WorldSpec, state: GameState, inst: ActorInstance, def: ActorDef): string {
  const npc = def.npc;
  const items = new Map(world.items.map((i) => [i.id, i]));
  const lines = [`NPC ${inst.id} = ${def.name} [${def.id}] (${inst.faction}${def.unique ? ', unique' : ''}, hp ${inst.hp}/${inst.maxHp})`, `description: ${def.description}`];
  if (npc) {
    lines.push(`role: ${npc.role}; personality: ${npc.personality}`);
    lines.push(`greeting (offline): ${npc.greeting}`);
    if (npc.lines.length) lines.push(`typical lines: ${npc.lines.join(' / ')}`);
    if (npc.secrets) lines.push(`secrets: ${npc.secrets}`);
    if (npc.wants) lines.push(`wants: ${npc.wants}`);
    if (npc.stock.length) {
      lines.push(
        `stock: ${npc.stock
          .map((id) => items.get(id))
          .filter((d) => !!d)
          .map((d) => `${d!.id} "${knownItemName(world, state, d!)}" (value ${d!.value})`)
          .join(', ')}`,
      );
    }
    lines.push(`persuade: ${npc.persuadeStat} vs ${npc.persuadeDifficulty}`);
  }
  if (inst.npcUsed?.length) lines.push(`services already used: ${inst.npcUsed.join(', ')}`);
  lines.push(inst.talkedTo ? 'They have met the player before.' : 'This is their first conversation.');
  return lines.join('\n');
}

export function dialogueUserMessage(input: DialoguePromptInput): string {
  const found = npcOf(input.world, input.state, input.npcId);
  const parts: string[] = [gmSituation({ world: input.world, state: input.state, difficulty: input.difficulty, maxList: 8 })];
  if (found) parts.push(npcBlock(input.world, input.state, found.inst, found.def));
  else parts.push(`NPC ${input.npcId} (not in this area any more: say a brief farewell and end).`);
  const used = input.helpfulUsed ?? 0;
  parts.push(`HELP USED this area: ${used} of ${HELPFUL_CEILING[input.difficulty]}`);
  const hist = (input.history ?? []).slice(-DIALOGUE_HISTORY_TURNS);
  if (hist.length) parts.push(`CONVERSATION SO FAR\n${hist.map((h) => `${h.speaker === 'npc' ? 'NPC' : 'PLAYER'}: ${h.text}`).join('\n')}`);
  const said = (input.playerLine ?? '').trim();
  parts.push(said ? `The player says: "${said.slice(0, 300)}"\nReply as the NPC with the DialogueResponse JSON.` : 'The player approaches and starts the conversation. Open it as the NPC with the DialogueResponse JSON.');
  return parts.join('\n\n');
}

export function buildDialoguePrompt(input: DialoguePromptInput): { system: string; user: string } {
  return { system: dialogueSystemPrompt(input.world, input.difficulty), user: dialogueUserMessage(input) };
}

export function dialogueRequest(input: DialoguePromptInput, purpose: string, extra: Partial<CompletionRequest> = {}): CompletionRequest {
  const p = buildDialoguePrompt(input);
  return {
    system: p.system,
    messages: [{ role: 'user', content: p.user }],
    schemaName: DIALOGUE_SCHEMA_NAME,
    maxTokens: DIALOGUE_MAX_TOKENS,
    temperature: DIALOGUE_TEMPERATURE,
    purpose,
    ...extra,
  };
}
