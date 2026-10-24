/**
 * Deterministic game situations for prompt tooling and tests: play a world with a sim bot until a
 * given area / turn, so tools/print-prompt.ts and tools/agent-provider.ts build the exact GM or
 * dialogue context (and validate a response against the exact same snapshot) from the same
 * arguments. Pure and seeded: the same world, seed and options always give the same state.
 */
import type { WorldSpec } from '../schema/world';
import type { Difficulty, GmHook } from '../schema/gm';
import type { GameState, LogMessage } from '../engine/types';
import { createGame, step } from '../engine/index';
import { botByName, newMemory, type BotName } from '../engine/sim/bots';
import type { GmPromptInput } from './prompts/gm';
import type { DialoguePromptInput, DialogueLine } from './prompts/dialogue';

export interface SituationOptions {
  seed?: number;
  /** area index to reach (default 0) */
  area?: number;
  /** turns to play inside that area before the snapshot (default 0 = on arrival) */
  turnsInArea?: number;
  difficulty?: Difficulty;
  bot?: BotName;
  /** safety cap on bot decisions (default 6000) */
  maxSteps?: number;
}

export interface Situation {
  state: GameState;
  difficulty: Difficulty;
  recentLog: LogMessage[];
  areaEnteredTurn: number;
  /** false when the run ended or the cap hit before the requested point */
  reached: boolean;
}

export function playToSituation(world: WorldSpec, opts: SituationOptions = {}): Situation {
  const difficulty = opts.difficulty ?? 'normal';
  const seed = opts.seed ?? 1;
  const targetArea = Math.max(0, Math.min(world.areas.length - 1, opts.area ?? 0));
  const turnsIn = Math.max(0, opts.turnsInArea ?? 0);
  const bot = botByName(opts.bot ?? 'explorer');
  const mem = newMemory(seed);
  let s = createGame(world, { seed, difficulty });
  let entered = 0;
  let steps = 0;
  const cap = opts.maxSteps ?? 6000;
  const done = () => s.area.index > targetArea || (s.area.index === targetArea && s.turn - entered >= turnsIn);
  while (s.status === 'playing' && !done() && steps < cap) {
    const before = s.area.index;
    const action = bot.decide(s, world, mem);
    const r = step(s, action, { world });
    s = r.state;
    steps++;
    if (s.area.index !== before) entered = s.turn;
  }
  const reached = s.status === 'playing' && s.area.index === targetArea && s.turn - entered >= turnsIn;
  return { state: s, difficulty, recentLog: s.log.slice(-8), areaEnteredTurn: entered, reached };
}

/**
 * The snapshot as the hook would see it in play: a bot playthrough reaches the area at full health
 * and still playing, so low_hp gets the player at a quarter of their hp, and death / victory get the
 * run ended (lost / won). Other hooks get the snapshot unchanged. Never mutates `sit`.
 */
export function stateForHook(sit: Situation, hook: GmHook): GameState {
  if (hook !== 'low_hp' && hook !== 'death' && hook !== 'victory') return sit.state;
  const s = structuredClone(sit.state);
  const p = s.area.actors.find((a) => a.id === s.player.actorId);
  if (hook === 'low_hp') {
    if (p) p.hp = Math.max(1, Math.min(p.hp, Math.ceil(p.maxHp * 0.25)));
  } else if (hook === 'death') {
    if (p) p.hp = 0;
    s.status = 'lost';
  } else {
    s.status = 'won';
  }
  return s;
}

export function gmInputFor(world: WorldSpec, sit: Situation, hook: GmHook, opts: { weirdness?: number; detail?: GmPromptInput['detail']; helpfulUsed?: number } = {}): GmPromptInput {
  return {
    world,
    state: stateForHook(sit, hook),
    difficulty: sit.difficulty,
    weirdness: opts.weirdness,
    recentLog: sit.recentLog,
    areaEnteredTurn: sit.areaEnteredTurn,
    hook,
    area: sit.state.area.index,
    turn: sit.state.turn,
    ...(opts.detail ? { detail: opts.detail } : {}),
    helpfulUsed: opts.helpfulUsed ?? 0,
  };
}

/** NPC instances in the snapshot's area (talkable actors), nearest to the player first */
export function npcsInArea(world: WorldSpec, state: GameState): { id: string; defId: string; name: string }[] {
  const defs = new Map(world.actors.map((a) => [a.id, a]));
  const p = state.area.actors.find((a) => a.id === state.player.actorId);
  return state.area.actors
    .filter((a) => a.hp > 0 && defs.get(a.defId)?.npc)
    .sort((a, b) => (p ? Math.max(Math.abs(a.pos.x - p.pos.x), Math.abs(a.pos.y - p.pos.y)) - Math.max(Math.abs(b.pos.x - p.pos.x), Math.abs(b.pos.y - p.pos.y)) : 0))
    .map((a) => ({ id: a.id, defId: a.defId, name: defs.get(a.defId)!.name }));
}

export function dialogueInputFor(world: WorldSpec, sit: Situation, npc: string, opts: { history?: DialogueLine[]; playerLine?: string } = {}): DialoguePromptInput {
  const list = npcsInArea(world, sit.state);
  const hit = list.find((n) => n.id === npc) ?? list.find((n) => n.defId === npc);
  if (!hit) {
    throw new Error(`no NPC "${npc}" in area ${sit.state.area.index} (${list.map((n) => `${n.defId} = ${n.id}`).join(', ') || 'none here'})`);
  }
  return { world, state: sit.state, npcId: hit.id, difficulty: sit.difficulty, history: opts.history ?? [], playerLine: opts.playerLine ?? '' };
}
