/**
 * Checks for GM and dialogue responses, shared by the GM runtime (gm-runtime.ts) and the agent
 * tooling (tools/agent-provider.ts): hook rules, an engine dry run of every action (references,
 * budget, rule limits), the help classification behind the per-area help ceiling, and the JSON
 * Schemas attached to GM / dialogue requests. Browser-safe; no client imports.
 */
import type { WorldSpec } from '../schema/world';
import { DialogueResponse, GmResponse, type GmAction, type GmHook } from '../schema/gm';
import type { GameState } from '../engine/types';
import { applyGmActions, estimateRuleImpact } from '../engine/index';
import { toJsonSchema } from './structured';
import { npcOf } from './prompts/dialogue';

/** hooks after which nothing but words may happen */
const WORDS_ONLY: ReadonlySet<GmHook> = new Set(['intro', 'death', 'victory']);
const WORD_ACTIONS: ReadonlySet<GmAction['type']> = new Set(['narrate', 'say', 'mood']);

function isHarmfulStatus(world: WorldSpec, id: string): boolean {
  return !!world.statuses.find((s) => s.id === id)?.harmful;
}

function itemHelps(world: WorldSpec, id: string): boolean {
  const def = world.items.find((i) => i.id === id);
  if (!def) return false;
  const fx = def.onUse?.effects ?? [];
  const selfHarm =
    !!def.onUse &&
    (def.onUse.targeting.affects === 'self_only' || def.onUse.targeting.shape === 'self') &&
    fx.some((e) => e.type === 'damage' || (e.type === 'apply_status' && isHarmfulStatus(world, e.status)));
  return !selfHarm;
}

/** whether a GM action helps the player (counts against the help ceiling) */
export function isHelpfulAction(world: WorldSpec, a: GmAction): boolean {
  switch (a.type) {
    case 'give_item':
    case 'place_item':
      return itemHelps(world, a.item);
    case 'grant_xp':
      return true;
    case 'currency':
      return a.amount > 0;
    case 'effect':
      return (
        a.target === 'player' &&
        a.effects.some(
          (e) =>
            e.type === 'heal' ||
            (e.type === 'modify_stat' && e.amount > 0) ||
            e.type === 'remove_status' ||
            (e.type === 'apply_status' && !isHarmfulStatus(world, e.status)) ||
            (e.type === 'resource' && (e.amount.base ?? 0) > 0) ||
            e.type === 'grant_xp' ||
            e.type === 'currency',
        )
      );
    case 'add_rule':
      try {
        return estimateRuleImpact(world, a.rule).hpPer100 < 0;
      } catch {
        return false;
      }
    case 'remove_rule': {
      const r = world.rules.find((x) => x.id === a.id);
      if (!r) return true; // a GM-added rule: removing one is usually relief
      try {
        return estimateRuleImpact(world, r).hpPer100 > 0;
      } catch {
        return false;
      }
    }
    case 'offer_choice':
      return a.options.some((o) => o.actions.some((x) => isHelpfulAction(world, x)));
    default:
      return false;
  }
}

export interface GmCheckOptions {
  hook?: GmHook;
  /** extra readable problems (prefixed with the action path) */
  extra?: (actions: GmAction[]) => string[];
}

/**
 * Problems with a list of GM actions against the current snapshot: hook rules, and every action the
 * engine would refuse (dry run through applyGmActions, action by action, so budgets accumulate).
 * Messages start with the action path ("actions[2] (spawn): …") for repair feedback.
 */
export function gmActionProblems(world: WorldSpec, state: GameState, actions: readonly GmAction[], opts: GmCheckOptions = {}): { index: number; message: string }[] {
  const out: { index: number; message: string }[] = [];
  const label = (i: number) => `actions[${i}] (${actions[i]!.type})`;
  if (opts.hook && WORDS_ONLY.has(opts.hook)) {
    actions.forEach((a, i) => {
      if (!WORD_ACTIONS.has(a.type)) out.push({ index: i, message: `${label(i)}: the "${opts.hook}" hook allows only narrate, say and mood` });
    });
  }
  if (state.status !== 'playing') return out;
  let s = state;
  actions.forEach((a, i) => {
    if (out.some((o) => o.index === i)) return;
    try {
      const r = applyGmActions(s, [a], { world });
      const skipped = r.gmSkipped ?? [];
      if (skipped.length) {
        out.push({ index: i, message: `${label(i)}: refused by the engine: ${[...new Set(skipped.map((k) => k.reason))].join('; ')}` });
      } else s = r.state;
    } catch (e) {
      out.push({ index: i, message: `${label(i)}: the engine could not apply it (${e instanceof Error ? e.message : String(e)})` });
    }
  });
  return out;
}

/** readable problems (empty = fine) for a GmResponse */
export function gmResponseErrors(world: WorldSpec, state: GameState, r: GmResponse, hook?: GmHook): string[] {
  return gmActionProblems(world, state, r.actions, { hook }).map((p) => p.message);
}

/** keep only the actions the checks accept */
export function keepValidActions(world: WorldSpec, state: GameState, actions: readonly GmAction[], hook?: GmHook): GmAction[] {
  const bad = new Set(gmActionProblems(world, state, actions, { hook }).map((p) => p.index));
  return actions.filter((_, i) => !bad.has(i));
}

/** problems with a DialogueResponse (its actions, plus the options contract) */
export function dialogueResponseErrors(world: WorldSpec, state: GameState, npcId: string, r: DialogueResponse): string[] {
  // a trade by the speaking NPC is dropped, not applied (dropTrades): the conversation is itself the
  // open choice, and the engine already lists a trader's goods, so it is not dry-run here
  const errs = gmActionProblems(world, state, r.actions.filter((a) => a.type !== 'trade')).map((p) => p.message);
  if (r.end && r.options.length) errs.push('options: must be empty when end is true');
  if (!r.reply.trim()) errs.push('reply: must not be empty');
  const npcDef = npcOf(world, state, npcId)?.def.id;
  for (const [i, a] of r.actions.entries()) {
    // the speaking NPC by instance id, or by its def id (recordings replay across runs)
    if (a.type === 'trade' && a.actorId !== npcId && a.actorId !== npcDef) {
      errs.push(`actions[${i}] (trade): actorId must be the speaking NPC "${npcId}"${npcDef ? ` (or "${npcDef}")` : ''}`);
    }
  }
  return errs;
}

/**
 * A conversation's actions without `trade`: while an NPC talks, the dialogue is the open choice (a
 * trade would be refused with "a choice is already open") and the engine's own options already
 * buy and sell, so a recorded or live trade is dropped instead of costing the whole reply.
 */
export function dropTrades<T extends { actions: readonly GmAction[] }>(r: T): T {
  return r.actions.some((a) => a.type === 'trade') ? { ...r, actions: r.actions.filter((a) => a.type !== 'trade') } : r;
}

/** limit helpful actions to what is left of the area's ceiling; returns the kept actions and the help used */
export function applyHelpCeiling(world: WorldSpec, actions: readonly GmAction[], remaining: number): { actions: GmAction[]; used: number } {
  const out: GmAction[] = [];
  let used = 0;
  for (const a of actions) {
    if (isHelpfulAction(world, a)) {
      if (used >= remaining) continue;
      used++;
    }
    out.push(a);
  }
  return { actions: out, used };
}

let gmSchemaCache: object | null = null;
let dialogueSchemaCache: object | null = null;
/** JSON Schemas attached to GM / dialogue requests (native structured output where supported) */
export function gmJsonSchema(): object {
  return (gmSchemaCache ??= toJsonSchema(GmResponse));
}
export function dialogueJsonSchema(): object {
  return (dialogueSchemaCache ??= toJsonSchema(DialogueResponse));
}

