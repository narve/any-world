/**
 * Checks for GM and dialogue responses, shared by the GM runtime (gm-runtime.ts) and the agent
 * tooling (tools/agent-provider.ts): hook rules, an engine dry run of every action (references,
 * budget, rule limits), the help classification behind the per-area help ceiling, and the JSON
 * Schemas attached to GM / dialogue requests. Browser-safe; no client imports.
 */
import type { Amount, Effect, Trigger, WorldSpec } from '../schema/world';
import { DialogueResponse, GmResponse, type GmAction, type GmHook } from '../schema/gm';
import type { ActorInstance, GameState } from '../engine/types';
import { applyGmActions, estimateRuleImpact } from '../engine/index';
import { toJsonSchema } from './structured';
import { npcOf } from './prompts/dialogue';
import { GM_HARMFUL_STATUS_TURNS, goalRefs, type GoalRefs } from './goal-refs';

export { GM_HARMFUL_STATUS_TURNS, goalRefs, type GoalRefs };

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

/** effects that hurt or hinder whoever they land on (used for effects aimed at enemies) */
function hindersTarget(world: WorldSpec, e: Effect): boolean {
  switch (e.type) {
    case 'damage':
      return true;
    case 'apply_status':
      return isHarmfulStatus(world, e.status);
    case 'modify_stat':
      return e.amount < 0;
    case 'resource':
      return (e.amount.base ?? 0) < 0;
    case 'change_faction':
      return e.faction !== 'hostile';
    default:
      return false;
  }
}

/** an actor instance (by instance id, else the nearest living one of that def) */
function actorRef(state: GameState | undefined, ref: string): ActorInstance | undefined {
  if (!state) return undefined;
  const alive = state.area.actors.filter((a) => a.hp > 0);
  return alive.find((a) => a.id === ref) ?? alive.find((a) => a.defId === ref);
}

/**
 * Whether a GM action helps the player (counts against the help ceiling): gifts, xp, money,
 * healing and buffs, effects that hurt or pacify enemies, turning a hostile actor, spawning an ally,
 * quests with rewards, and rules that ease the run. `state` (optional) lets change_faction check
 * whether the actor is hostile now; without it, any turn towards neutral / friendly counts.
 */
export function isHelpfulAction(world: WorldSpec, a: GmAction, state?: GameState): boolean {
  switch (a.type) {
    case 'give_item':
    case 'place_item':
      return itemHelps(world, a.item);
    case 'grant_xp':
      return true;
    case 'currency':
      return a.amount > 0;
    case 'effect':
      if (a.target !== 'player') return a.effects.some((e) => hindersTarget(world, e));
      return a.effects.some(
        (e) =>
          e.type === 'heal' ||
          (e.type === 'modify_stat' && e.amount > 0) ||
          e.type === 'remove_status' ||
          (e.type === 'apply_status' && !isHarmfulStatus(world, e.status)) ||
          (e.type === 'resource' && (e.amount.base ?? 0) > 0) ||
          e.type === 'grant_xp' ||
          e.type === 'currency' ||
          (e.type === 'spawn_item' && itemHelps(world, e.item)) ||
          (e.type === 'summon' && e.allied) ||
          // a hop to the exit skips the area (every foe and hazard on the way): the strongest help
          (e.type === 'teleport' && e.mode === 'to_exit'),
      );
    case 'change_faction': {
      if (a.faction === 'hostile') return false;
      const inst = actorRef(state, a.actorId);
      return inst ? inst.faction === 'hostile' : true;
    }
    case 'spawn': {
      const def = world.actors.find((d) => d.id === a.actor);
      return !!def && (def.faction ?? 'hostile') === 'friendly' && !def.npc;
    }
    case 'start_quest':
      return a.reward.length > 0;
    case 'add_rule':
      // a rule that strikes or hinders the player's foes is help (the engine's impact estimate only
      // scores what reaches the player); such rules are refused anyway (goalWriteProblem)
      if ((a.rule.playerTriggers ?? []).some((t) => triggerReachesFoes(t) && t.action.effects.some((e) => hindersTarget(world, e)))) return true;
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
      return a.options.some((o) => o.actions.some((x) => isHelpfulAction(world, x, state)));
    case 'trade':
      // a bargain (any price below the item's value) is a gift in part
      return a.items.some((x) => {
        const def = world.items.find((i) => i.id === x.item);
        return !!def && x.price < def.value && itemHelps(world, x.item);
      });
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Bounds on what one GM action may do (separate from world-authored Effects)
// ---------------------------------------------------------------------------

/** largest damage / heal / resource change one GM effect may carry (base + dice maximum + scale) */
export const GM_AMOUNT_LIMIT = 50;
/** stat value assumed for an Amount's `scale` part when bounding it */
const SCALE_STAT_GUESS = 20;

/** the most an Amount can come to (magnitude): |base| + the dice maximum + |factor| x a typical stat */
export function amountMax(a: Amount): number {
  let n = Math.abs(Number.isFinite(a.base) ? a.base : Infinity);
  const m = a.dice ? /^(\d+)d(\d+)$/.exec(a.dice) : null;
  if (m) n += Number(m[1]) * Number(m[2]);
  if (a.scale) n += Math.abs(Number.isFinite(a.scale.factor) ? a.scale.factor : Infinity) * SCALE_STAT_GUESS;
  return n;
}


function effectBoundProblem(world: WorldSpec, e: Effect): string | null {
  if (e.type === 'damage' || e.type === 'heal' || e.type === 'resource') {
    const max = amountMax(e.amount);
    if (max > GM_AMOUNT_LIMIT) return `${e.type} amount can reach ${Number.isFinite(max) ? Math.round(max) : 'infinity'}; a GM effect may carry at most ${GM_AMOUNT_LIMIT} (base + dice + scale)`;
  }
  if (e.type === 'apply_status' && isHarmfulStatus(world, e.status) && e.duration > GM_HARMFUL_STATUS_TURNS) {
    return `harmful status "${e.status}" for ${e.duration} turns; a GM effect may apply a harmful status for at most ${GM_HARMFUL_STATUS_TURNS} turns`;
  }
  return null;
}

/** the lowest price the GM may ask for an item (half its value, rounded up) */
export function tradeFloor(world: WorldSpec, item: string): number {
  const def = world.items.find((i) => i.id === item);
  return def ? Math.ceil(def.value / 2) : 0;
}

/**
 * World-only bounds (null = fine): GM effect amounts within GM_AMOUNT_LIMIT and harmful statuses
 * within GM_HARMFUL_STATUS_TURNS (in `effect` actions and add_rule triggers), and trade prices at
 * least half the item's value. Recurses into offer options.
 */
export function boundProblem(world: WorldSpec, a: GmAction): string | null {
  switch (a.type) {
    case 'effect':
      for (const e of a.effects) {
        const p = effectBoundProblem(world, e);
        if (p) return p;
      }
      return null;
    case 'add_rule':
      // a rule's triggers carry the same Effects as an `effect` action, fired again and again
      for (const t of a.rule.playerTriggers ?? []) {
        for (const e of t.action.effects) {
          const p = effectBoundProblem(world, e);
          if (p) return p;
        }
      }
      return null;
    case 'trade':
      for (const x of a.items) {
        const floor = tradeFloor(world, x.item);
        if (x.price < floor) return `item "${x.item}" priced ${x.price}; the GM may not sell below half its value (at least ${floor})`;
      }
      return null;
    case 'offer_choice':
      for (const o of a.options) {
        for (const x of o.actions) {
          const p = boundProblem(world, x);
          if (p) return p;
        }
      }
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Goal protection: the GM never completes (or fails) the run, nor opens a lock, by fiat
// ---------------------------------------------------------------------------

const GOAL_HINT = 'the world\'s goal or an area lock depends on it, so only the player\'s own play may change it';

/**
 * Why the GM may not bring an actor of this def into being (null = fine): a def the goal or a lock
 * names in actor_defeated (every death of one counts, so a copy is a defeat by fiat), or a unique
 * def (one of a kind: a copy would stand in for the world's own).
 */
function creationProblem(world: WorldSpec, refs: GoalRefs, defId: string): string | null {
  if (refs.actors.has(defId)) return `actor "${defId}": ${GOAL_HINT} (the GM may not create one)`;
  if (world.actors.find((d) => d.id === defId)?.unique) return `actor "${defId}" is unique; the GM may not create another`;
  return null;
}

/** whether a trigger's targeting can land on the player's foes (rule triggers run on the player) */
function triggerReachesFoes(t: Trigger): boolean {
  const tg = t.action.targeting;
  return tg.shape !== 'self' && (tg.affects === 'enemies' || tg.affects === 'all');
}

function effectGoalProblem(world: WorldSpec, refs: GoalRefs, e: Effect, allowItems: ReadonlySet<string>): string | null {
  if (e.type === 'summon') return creationProblem(world, refs, e.actor);
  if (e.type === 'transform' && !refs.actors.has(e.into)) {
    const p = creationProblem(world, refs, e.into);
    if (p) return p;
  }
  if (e.type === 'set_flag' && refs.flags.has(e.flag)) return `flag "${e.flag}": ${GOAL_HINT}`;
  if ((e.type === 'resource' && refs.stats.has(e.resource)) || (e.type === 'modify_stat' && refs.stats.has(e.stat))) {
    return `stat "${e.type === 'resource' ? e.resource : e.stat}": ${GOAL_HINT}`;
  }
  if (e.type === 'transform' && refs.actors.has(e.into)) return `actor "${e.into}": ${GOAL_HINT}`;
  if (e.type === 'counter' && refs.counters.has(e.counter)) return `counter "${e.counter}": ${GOAL_HINT}`;
  if (e.type === 'spawn_item' && refs.items.has(e.item) && !allowItems.has(e.item)) return `item "${e.item}": ${GOAL_HINT}`;
  return null;
}

/**
 * Why a GM / dialogue action would win, lose or unlock by fiat (null = fine): set_flag or counter
 * writes to a flag / counter that goal.win, goal.lose or any transitionRequires references (also
 * inside effects, rules and offer options), resource / modify_stat effects on a stat those
 * conditions read, handing out (give / place / spawn / quest reward / trade) an item those
 * conditions require, change_faction on an actor def they name in actor_defeated, creating (spawn,
 * summon, transform into) such an actor or any unique one, and add_rule triggers that strike the
 * player's foes. `allowItems` exempts items the world itself lets the speaker
 * hand over (the stock of the NPC who is talking).
 */
export function goalWriteProblem(world: WorldSpec, a: GmAction, allowItems: ReadonlySet<string> = new Set()): string | null {
  const refs = goalRefs(world);
  const item = (id: string | undefined) => (id && refs.items.has(id) && !allowItems.has(id) ? `item "${id}": ${GOAL_HINT}` : null);
  switch (a.type) {
    case 'set_flag':
      return refs.flags.has(a.flag) ? `flag "${a.flag}": ${GOAL_HINT}` : null;
    case 'give_item':
    case 'place_item':
      return item(a.item);
    case 'trade':
      for (const x of a.items) {
        const p = item(x.item);
        if (p) return p;
      }
      return null;
    case 'change_faction':
      return refs.actors.has(a.actorId) ? `actor "${a.actorId}": ${GOAL_HINT}` : null;
    case 'spawn':
      return creationProblem(world, refs, a.actor);
    case 'start_quest':
      for (const r of a.reward) {
        const p = r.type === 'give_item' ? item(r.item) : null;
        if (p) return p;
      }
      return null;
    case 'effect':
      for (const e of a.effects) {
        const p = effectGoalProblem(world, refs, e, allowItems);
        if (p) return p;
      }
      return null;
    case 'add_rule': {
      const vc = a.rule.switches?.violenceCounter;
      if (vc && refs.counters.has(vc)) return `counter "${vc}": ${GOAL_HINT}`;
      for (const t of a.rule.playerTriggers ?? []) {
        // a standing rule keeps firing in every later area, at whatever the goal names there, and
        // the engine's power limit only scores what reaches the player: no rule may strike foes
        if (triggerReachesFoes(t) && t.action.effects.some((e) => hindersTarget(world, e) || e.type === 'transform')) {
          return `a GM rule may not hurt, hinder or transform the player's foes (it would keep firing at the goal's actors); use a one-off effect instead`;
        }
        for (const e of t.action.effects) {
          const p = effectGoalProblem(world, refs, e, allowItems);
          if (p) return p;
        }
      }
      return null;
    }
    case 'offer_choice':
      for (const o of a.options) {
        for (const x of o.actions) {
          const p = goalWriteProblem(world, x, allowItems);
          if (p) return p;
        }
      }
      return null;
    default:
      return null;
  }
}

/** living actors in the area whose def the goal or a lock names in actor_defeated */
function goalActorsInArea(world: WorldSpec, state: GameState): ActorInstance[] {
  const refs = goalRefs(world);
  if (!refs.actors.size) return [];
  return state.area.actors.filter((x) => x.hp > 0 && x.id !== state.player.actorId && refs.actors.has(x.defId));
}

/**
 * The most one list of effects can take from its target's hp: damage, negative hp resource,
 * negative hp / maxHp stat changes, and harmful statuses (their per-turn hp loss x duration, plus
 * their hp / maxHp modifiers). Statuses applied by a status's own per-turn effects count once.
 */
function maxHpLoss(world: WorldSpec, effects: readonly Effect[], depth = 0): number {
  let n = 0;
  for (const e of effects) {
    if (e.type === 'damage') n += amountMax(e.amount);
    else if (e.type === 'resource' && e.resource === 'hp' && (e.amount.base ?? 0) < 0) n += amountMax(e.amount);
    else if (e.type === 'modify_stat' && (e.stat === 'hp' || e.stat === 'maxHp') && e.amount < 0) n += -e.amount;
    else if (e.type === 'apply_status' && depth < 2) {
      const def = world.statuses.find((x) => x.id === e.status);
      if (!def) continue;
      n += maxHpLoss(world, def.perTurn, depth + 1) * e.duration;
      for (const m of def.modifiers) if ((m.stat === 'hp' || m.stat === 'maxHp') && m.amount < 0) n += -m.amount;
    }
  }
  return n;
}

/**
 * Why a GM action would, against this snapshot, decide the run by fiat (null = fine): harmful or
 * transforming effects at enemies while an actor the goal names in actor_defeated is in the area
 * (the targets are picked when the action lands, so the whole area counts), change_faction on such
 * an actor, damage that could knock the player out, and a trade from a hostile actor.
 */
export function stateGoalProblem(world: WorldSpec, state: GameState, a: GmAction): string | null {
  switch (a.type) {
    case 'effect': {
      if (a.target === 'player') {
        const pl = state.area.actors.find((x) => x.id === state.player.actorId);
        const loss = maxHpLoss(world, a.effects);
        if (pl && loss > 0 && loss >= pl.hp) return `hp loss up to ${Math.round(loss)} (damage, harmful statuses) could knock the player out (hp ${pl.hp}); the GM never decides the run by fiat`;
        return null;
      }
      if (!a.effects.some((e) => hindersTarget(world, e) || e.type === 'transform')) return null;
      const boss = goalActorsInArea(world, state)[0];
      return boss ? `actor "${boss.defId}" is in this area: ${GOAL_HINT} (no harmful effects at enemies here)` : null;
    }
    case 'change_faction': {
      const inst = actorRef(state, a.actorId);
      return inst && goalRefs(world).actors.has(inst.defId) ? `actor "${inst.defId}": ${GOAL_HINT}` : null;
    }
    case 'trade': {
      const inst = actorRef(state, a.actorId);
      return inst && inst.faction === 'hostile' ? `actor "${a.actorId}" is hostile and does not trade` : null;
    }
    case 'offer_choice':
      for (const o of a.options) {
        for (const x of o.actions) {
          const p = stateGoalProblem(world, state, x);
          if (p) return p;
        }
      }
      return null;
    default:
      return null;
  }
}

/** why the dry run of one action decided the run or harmed a goal actor (null = fine) */
function outcomeProblem(world: WorldSpec, before: GameState, after: GameState): string | null {
  if (before.status === 'playing' && after.status !== 'playing') return `it would end the run (${after.status}); ${GOAL_HINT}`;
  for (const g of goalActorsInArea(world, before)) {
    const now = after.area.actors.find((x) => x.id === g.id);
    if (!now || now.hp <= 0 || now.defId !== g.defId || now.hp < g.hp || now.faction !== g.faction) return `actor "${g.defId}": ${GOAL_HINT}`;
  }
  return null;
}

export interface GmCheckOptions {
  hook?: GmHook;
  /** goal / lock items the speaker may still hand over (see goalWriteProblem) */
  allowItems?: ReadonlySet<string>;
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
  actions.forEach((a, i) => {
    if (out.some((o) => o.index === i)) return;
    const p = goalWriteProblem(world, a, opts.allowItems) ?? boundProblem(world, a) ?? stateGoalProblem(world, state, a);
    if (p) out.push({ index: i, message: `${label(i)}: refused: ${p}` });
  });
  if (state.status !== 'playing') return out;
  let s = state;
  actions.forEach((a, i) => {
    if (out.some((o) => o.index === i)) return;
    try {
      const r = applyGmActions(s, [a], { world });
      const skipped = r.gmSkipped ?? [];
      const outcome = skipped.length ? null : outcomeProblem(world, s, r.state);
      if (skipped.length) {
        out.push({ index: i, message: `${label(i)}: refused by the engine: ${[...new Set(skipped.map((k) => k.reason))].join('; ')}` });
      } else if (outcome) {
        out.push({ index: i, message: `${label(i)}: refused: ${outcome}` });
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
export function keepValidActions(world: WorldSpec, state: GameState, actions: readonly GmAction[], hook?: GmHook, allowItems?: ReadonlySet<string>): GmAction[] {
  const bad = new Set(gmActionProblems(world, state, actions, { hook, ...(allowItems ? { allowItems } : {}) }).map((p) => p.index));
  return actions.filter((_, i) => !bad.has(i));
}

/** problems with a DialogueResponse (its actions, plus the options contract) */
export function dialogueResponseErrors(world: WorldSpec, state: GameState, npcId: string, r: DialogueResponse): string[] {
  // a trade by the speaking NPC is dropped, not applied (dropTrades): the conversation is itself the
  // open choice, and the engine already lists a trader's goods, so it is not dry-run here
  const errs = gmActionProblems(world, state, r.actions.filter((a) => a.type !== 'trade'), { allowItems: npcStock(world, state, npcId) }).map((p) => p.message);
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

/** the speaking NPC's stock: items the world lets that NPC hand over */
export function npcStock(world: WorldSpec, state: GameState, npcId: string): ReadonlySet<string> {
  return new Set(npcOf(world, state, npcId)?.def.npc?.stock ?? []);
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
export function applyHelpCeiling(world: WorldSpec, actions: readonly GmAction[], remaining: number, state?: GameState): { actions: GmAction[]; used: number } {
  const out: GmAction[] = [];
  let used = 0;
  for (const a of actions) {
    if (isHelpfulAction(world, a, state)) {
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

