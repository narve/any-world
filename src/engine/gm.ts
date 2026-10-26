/**
 * GM actions applied to the game state. Every action costs GM_ACTION_COST from the area budget
 * (GM_BUDGET_PER_AREA); actions beyond the budget, with invalid references or beyond the rule
 * limits are skipped with a `gm_skipped` event (diagnostics, not the player's log). Also GM rules
 * (add_rule / remove_rule, see rules.ts) and quests (start, completion, rewards).
 */
import type { GmAction, GmLeafAction } from '../schema/gm';
import type { Effect } from '../schema/world';
import { GM_ACTION_COST } from '../schema/gm';
import { RuleVariant } from '../schema/world';
import type { ActorInstance, PendingChoice, Pos, Quest } from './types';
import { type Ctx, actorName, emit, findActor, findFreeNear, isAlive, isPlayer, log, logKey, markBusy, me, partyActors, playerActor, withPlayer } from './ctx';
import { areaActorCap, areaHasRoom, spawnActor } from './actors';
import { partySeesTile } from './vision';
import { displayItemName, dropItemAt, giveItem } from './inventory';
import { applyEffectList, isVisibleToPlayer } from './effects';
import { reveal } from './knowledge';
import { FACTION_KEYS } from './log-keys';
import { grantXp } from './progression';
import { evalPartyFull } from './conditions';
import { side } from './stats';
import { cheb, dist2 } from './util';
import { addActiveRule, addRuleRefusal, estimateRuleImpact, removeActiveRule, removeRuleRefusal } from './rules';

/** records a refused GM action (an event for the GM runtime / debugging, never a player log line) */
export function gmSkip(ctx: Ctx, action: string, reason: string): void {
  emit(ctx, { type: 'gm_skipped', action, reason });
}

function skip(ctx: Ctx, a: GmAction, why: string): void {
  gmSkip(ctx, a.type, why);
}

/**
 * Whether `type` names a GM action. An own-property check: `in` would also accept inherited keys
 * such as "constructor" or "toString", whose "cost" is a Function (NaN budget).
 */
export function isGmActionType(type: unknown): type is GmAction['type'] {
  return typeof type === 'string' && Object.hasOwn(GM_ACTION_COST, type);
}

/** budget cost of one action type (0 for anything that is not a GM action type) */
function typeCost(type: unknown): number {
  return isGmActionType(type) ? GM_ACTION_COST[type] : 0;
}

function nearPos(ctx: Ctx, near: 'player' | 'random' | 'exit'): Pos | null {
  const map = ctx.s.area.map;
  if (near === 'player') return findFreeNear(ctx, playerActor(ctx).pos, 6, (q) => cheb(q, playerActor(ctx).pos) < 2);
  if (near === 'exit') return findFreeNear(ctx, map.exit, 6);
  const cands: Pos[] = [];
  const p = playerActor(ctx).pos;
  // at a distance from every standing player (and the lead, whom the GM serves in MP1)
  const keep = [p, ...partyActors(ctx).map((a) => a.pos)];
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++) {
      const t = map.tiles[y * map.width + x];
      if (t.kind !== 'floor') continue;
      const q = { x, y };
      if (keep.some((k) => cheb(q, k) < 5)) continue;
      cands.push(q);
    }
  ctx.rng.shuffle(cands);
  // somewhere a player can see, so nothing "appears" out of sight (FABLE-GAMEPLAY-REVIEW.md §3.5)
  const inView = cands.filter((q) => partySeesTile(ctx, q));
  for (const q of [...inView.slice(0, 50), ...cands.slice(0, 50)]) {
    const f = findFreeNear(ctx, q, 0);
    if (f) return f;
  }
  return findFreeNear(ctx, p, 10);
}

/** resolves GmAction.actorId: an instance id, or a def id of an actor in the area */
function resolveActor(ctx: Ctx, ref: string): ActorInstance | undefined {
  const byId = findActor(ctx, ref);
  if (byId && isAlive(ctx, byId)) return byId;
  const p = playerActor(ctx);
  return ctx.s.area.actors
    .filter((a) => a.defId === ref && a.hp > 0)
    .sort((a, b) => dist2(a.pos, p.pos) - dist2(b.pos, p.pos))[0];
}

/** label of the engine-added free option of a GM offer that has none (see offer_choice) */
export const DECLINE_LABEL = 'Decline';

/** total currency an option takes (sum of its negative `currency` actions) */
export function optionPrice(actions: readonly GmAction[]): number {
  return actions.reduce((n, a) => n + (a.type === 'currency' && a.amount < 0 ? -a.amount : 0), 0);
}

/** budget cost of a list of leaf actions */
function leafCost(actions: readonly GmAction[]): number {
  return actions.reduce((n, a) => n + typeCost(a?.type), 0);
}

/**
 * Budget cost of one GM action. An offer_choice costs its own price plus the most expensive
 * option: the budget for the goods is reserved when the offer is made (the chosen option is then
 * applied without charging, and the unused part of the reservation is refunded), so other GM hooks
 * that spend the budget while the offer is open can never leave a paid option half-applied.
 */
export function gmActionCost(a: GmAction): number {
  const base = typeCost(a.type);
  if (a.type !== 'offer_choice') return base;
  const options = Array.isArray(a.options) ? a.options : [];
  return base + Math.max(0, ...options.map((o) => leafCost(offerLeaves(o))));
}

/** reference check of an effect list (null when every id exists) */
function effectRefError(ctx: Ctx, effects: readonly Effect[]): string | null {
  const ix = ctx.ix;
  for (const e of effects) {
    if (e.type === 'apply_status' && !ix.statuses.has(e.status)) return `unknown status "${e.status}"`;
    if (e.type === 'summon' && !ix.actors.has(e.actor)) return `unknown actor "${e.actor}"`;
    if (e.type === 'spawn_item' && !ix.items.has(e.item)) return `unknown item "${e.item}"`;
    if (e.type === 'spawn_terrain' && !ix.terrains.has(e.terrain)) return `unknown terrain "${e.terrain}"`;
    if (e.type === 'transform' && !ix.actors.has(e.into)) return `unknown actor "${e.into}"`;
  }
  return null;
}

/** reference check of a leaf action (null when it names only existing items/actors/statuses) */
function leafRefError(ctx: Ctx, a: GmAction): string | null {
  const ix = ctx.ix;
  switch (a.type) {
    case 'give_item':
    case 'place_item':
    case 'reveal_item':
      return ix.items.has(a.item) ? null : `unknown item "${a.item}"`;
    case 'spawn':
      return ix.actors.has(a.actor) ? null : `unknown actor "${a.actor}"`;
    case 'effect':
      return effectRefError(ctx, a.effects);
    case 'add_rule':
      return ruleError(ctx, a.rule).error;
    default:
      return isGmActionType(a.type) ? null : 'unknown type';
  }
}

/**
 * The actions of an offer option the engine will consider: well-formed leaf actions only (objects
 * with a known type, no nested offer_choice). Anything else in a GM/LLM response is dropped.
 */
function offerLeaves(o: unknown): GmAction[] {
  const actions = (o as { actions?: unknown })?.actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter((x): x is GmAction => !!x && typeof x === 'object' && isGmActionType((x as GmAction).type) && (x as GmAction).type !== 'offer_choice');
}

/** resource ids an effect may change: hp, mp, the core stats and the world's custom resources */
const CORE_RESOURCES = new Set(['hp', 'mp', 'str', 'dex', 'int', 'ac', 'speed', 'sight']);

/** validates a GM rule (schema + references); returns the parsed rule or why it is refused */
function ruleError(ctx: Ctx, raw: unknown): { rule: RuleVariant | null; error: string | null } {
  const parsed = RuleVariant.safeParse(raw);
  if (!parsed.success) return { rule: null, error: `malformed rule (${parsed.error.issues[0]?.path.join('.') || 'rule'}: ${parsed.error.issues[0]?.message ?? 'invalid'})` };
  const rule = parsed.data;
  for (const tr of rule.playerTriggers) {
    const err = effectRefError(ctx, tr.action.effects);
    if (err) return { rule: null, error: err };
    for (const e of tr.action.effects) {
      if (e.type === 'resource' && !CORE_RESOURCES.has(e.resource) && !ctx.ix.resources.has(e.resource)) return { rule: null, error: `unknown resource "${e.resource}"` };
    }
  }
  return { rule, error: null };
}

export interface GmApplyOpts {
  /** charge the area GM budget (false for engine-built dialogue options and quest rewards) */
  charge: boolean;
}

export function applyGmList(ctx: Ctx, actions: readonly GmAction[], opts: GmApplyOpts): void {
  for (const a of actions) {
    if (ctx.s.status !== 'playing') return;
    if (!a || typeof a !== 'object' || !isGmActionType(a.type)) {
      gmSkip(ctx, 'action', 'unknown type');
      continue;
    }
    const cost = gmActionCost(a);
    // a non-finite cost or budget can only come from malformed input; never let it reach the budget
    if (!Number.isFinite(cost) || !Number.isFinite(ctx.s.area.gmBudget)) {
      skip(ctx, a, 'malformed cost');
      continue;
    }
    if (opts.charge && cost > ctx.s.area.gmBudget) {
      skip(ctx, a, 'over budget');
      continue;
    }
    const err = applyOne(ctx, a);
    if (err) {
      skip(ctx, a, err);
      continue;
    }
    if (opts.charge) {
      ctx.s.area.gmBudget -= cost;
      // the goods of an offer are reserved now; refunded in part when a cheaper option is chosen
      const pc = me(ctx).pendingChoice;
      if (a.type === 'offer_choice' && pc?.kind === 'gm_offer') pc.reservedBudget = cost - GM_ACTION_COST.offer_choice;
    }
  }
}

/** returns an error string when the action was not applied */
function applyOne(ctx: Ctx, a: GmAction): string | null {
  const ix = ctx.ix;
  switch (a.type) {
    case 'narrate':
      log(ctx, a.text, 'gm');
      return null;
    case 'say': {
      const actor = resolveActor(ctx, a.actorId);
      if (!actor) return `no actor "${a.actorId}"`;
      log(ctx, a.text, 'npc', actorName(ctx, actor));
      return null;
    }
    case 'mood':
      return null;
    case 'spawn': {
      if (!ix.actors.has(a.actor)) return `unknown actor "${a.actor}"`;
      if (!areaHasRoom(ctx)) return `the area is full (${areaActorCap(ctx)} actors)`;
      let n = 0;
      for (let i = 0; i < (a.count ?? 1); i++) {
        const p = nearPos(ctx, a.near ?? 'random');
        if (!p) break;
        const s = spawnActor(ctx, a.actor, p, { randomEnergy: true });
        if (s) n++;
      }
      if (!n) return 'nowhere to place it';
      const actorNm = ix.actors.get(a.actor)!.name;
      if (n > 1) logKey(ctx, 'log.appears_many', { actor: actorNm, count: n }, 'warning');
      else logKey(ctx, 'log.appears', { actor: actorNm }, 'warning');
      return null;
    }
    case 'give_item':
      if (!ix.items.has(a.item)) return `unknown item "${a.item}"`;
      giveItem(ctx, a.item, a.count ?? 1);
      return null;
    case 'place_item': {
      if (!ix.items.has(a.item)) return `unknown item "${a.item}"`;
      const p = nearPos(ctx, a.near ?? 'random');
      if (!p) return 'nowhere to place it';
      dropItemAt(ctx, a.item, 1, p);
      return null;
    }
    case 'effect': {
      const pl = playerActor(ctx);
      let targets: ActorInstance[] = [];
      if (a.target === 'player') targets = [pl];
      else {
        const enemies = ctx.s.area.actors.filter((x) => x.hp > 0 && side(ctx, x) === 'H' && isVisibleToPlayer(ctx, x));
        enemies.sort((x, y) => dist2(x.pos, pl.pos) - dist2(y.pos, pl.pos));
        targets = a.target === 'nearest_enemy' ? enemies.slice(0, 1) : enemies;
      }
      if (!targets.length) return 'no target';
      const refErr = effectRefError(ctx, a.effects);
      if (refErr) return refErr;
      for (const t of targets) {
        if (!isAlive(ctx, t)) continue;
        applyEffectList(ctx, a.effects, t, [t], t.pos, []);
      }
      return null;
    }
    case 'set_flag':
      ctx.s.flags[a.flag] = a.value ?? true;
      return null;
    case 'change_faction': {
      const actor = resolveActor(ctx, a.actorId);
      if (!actor || isPlayer(ctx, actor)) return `no actor "${a.actorId}"`;
      actor.faction = a.faction;
      if (a.faction === 'hostile') delete actor.allyOf;
      else {
        actor.ai.alerted = false;
        delete actor.ai.lastSeen;
      }
      logKey(ctx, FACTION_KEYS[a.faction], { actor: actorName(ctx, actor) }, a.faction === 'hostile' ? 'bad' : 'good');
      return null;
    }
    case 'reveal_item':
      if (!ix.items.has(a.item)) return `unknown item "${a.item}"`;
      reveal(ctx, a.item, a.level);
      return null;
    case 'start_quest': {
      if (ctx.s.quests.some((q) => q.id === a.id)) return `quest "${a.id}" already exists`;
      const reward: GmAction[] = [];
      for (const r of a.reward) {
        if (r.type === 'give_item') {
          if (r.item && ix.items.has(r.item)) reward.push({ type: 'give_item', item: r.item, count: 1 });
        } else if (r.type === 'grant_xp') reward.push({ type: 'grant_xp', amount: r.amount ?? 10 });
        else reward.push({ type: 'currency', amount: r.amount ?? 10 });
      }
      const q: Quest = { id: a.id, title: a.title, description: a.description, complete: a.complete, reward, status: 'active' };
      ctx.s.quests.push(q);
      emit(ctx, { type: 'quest_updated', questId: q.id, status: 'active' });
      logKey(ctx, 'log.quest.new', { title: q.title }, 'gm');
      return null;
    }
    case 'trade': {
      const actor = resolveActor(ctx, a.actorId);
      if (!actor) return `no actor "${a.actorId}"`;
      if (me(ctx).pendingChoice) return 'a choice is already open';
      const items = a.items.filter((x) => ix.items.has(x.item));
      if (!items.length) return 'no valid items';
      me(ctx).pendingChoice = {
        kind: 'dialogue',
        prompt: `${actorName(ctx, actor)}:`,
        speakerId: actor.id,
        options: [
          ...items.map((x) => ({
            label: `${displayItemName(ctx, x.item)} (${x.price} ${ctx.world.vocabulary.currency})`,
            actions: [{ type: 'currency', amount: -x.price } as GmLeafAction, { type: 'give_item', item: x.item, count: 1 } as GmLeafAction],
            tag: 'buy',
          })),
          { label: 'Leave', actions: [] },
        ],
      };
      markBusy(ctx, me(ctx));
      return null;
    }
    case 'currency':
      ctx.s.purse = Math.max(0, ctx.s.purse + a.amount);
      if (a.amount > 0) logKey(ctx, 'log.currency.gain', { amount: a.amount, currency: ctx.world.vocabulary.currency }, 'loot');
      else if (a.amount < 0) logKey(ctx, 'log.currency.spend', { amount: -a.amount, currency: ctx.world.vocabulary.currency }, 'info');
      return null;
    case 'grant_xp':
      grantXp(ctx, a.amount);
      return null;
    case 'offer_choice': {
      if (me(ctx).pendingChoice) return 'a choice is already open';
      // an option is offered whole or not at all: one naming a missing item/actor/status could
      // take the price and fail to deliver, so it is left out
      const options: PendingChoice['options'] = [];
      for (const o of Array.isArray(a.options) ? a.options : []) {
        if (!o || typeof o !== 'object') continue;
        const raw = Array.isArray(o.actions) ? o.actions : [];
        const actions = offerLeaves(o);
        // an option with an action the engine does not know is left out whole, like a bad reference
        if (actions.length !== raw.filter((x) => (x as GmAction)?.type !== 'offer_choice').length) continue;
        if (actions.some((x) => leafRefError(ctx, x))) continue;
        options.push({ label: String(o.label ?? ''), actions });
      }
      if (!options.length) return 'no valid options';
      // there is always a way out: a choice whose every option costs currency could otherwise
      // become impossible to resolve (and every other player action waits for it)
      if (!options.some((o) => optionPrice(o.actions) === 0)) options.push({ label: DECLINE_LABEL, actions: [], tag: 'decline' });
      me(ctx).pendingChoice = { kind: 'gm_offer', prompt: a.prompt, options };
      markBusy(ctx, me(ctx));
      log(ctx, a.prompt, 'gm');
      return null;
    }
    case 'add_rule': {
      const { rule, error } = ruleError(ctx, a.rule);
      if (!rule) return error ?? 'malformed rule';
      const refusal = addRuleRefusal(ctx, rule);
      if (refusal) return refusal;
      const reason = typeof a.reason === 'string' ? a.reason : '';
      const entry = addActiveRule(ctx, rule, reason);
      if (entry.reason) log(ctx, entry.reason, 'gm');
      const harmful = estimateRuleImpact(ctx.world, rule).harmful;
      if (rule.description) logKey(ctx, 'log.rule.new_desc', { name: rule.name, description: rule.description }, harmful ? 'warning' : 'good');
      else logKey(ctx, 'log.rule.new', { name: rule.name }, harmful ? 'warning' : 'good');
      emit(ctx, { type: 'rule_added', id: rule.id, name: rule.name, source: 'gm', ...(entry.reason ? { reason: entry.reason } : {}) });
      return null;
    }
    case 'remove_rule': {
      if (typeof a.id !== 'string') return 'malformed rule id';
      const refusal = removeRuleRefusal(ctx, a.id);
      if (refusal) return refusal;
      const gone = removeActiveRule(ctx, a.id);
      if (!gone) return `no rule "${a.id}" in force`;
      const reason = typeof a.reason === 'string' ? a.reason.trim() : '';
      if (reason) log(ctx, reason, 'gm');
      logKey(ctx, 'log.rule.lifted', { name: gone.rule.name }, 'info');
      emit(ctx, { type: 'rule_removed', id: gone.rule.id, name: gone.rule.name, ...(reason ? { reason } : {}) });
      return null;
    }
  }
  return 'unsupported';
}

/** marks active quests done when their condition holds for the party (evalParty) and pays rewards */
export function checkQuests(ctx: Ctx): void {
  for (const q of ctx.s.quests) {
    if (q.status !== 'active') continue;
    const r = evalPartyFull(ctx, q.complete, 'win');
    if (!r.ok) continue;
    q.status = 'done';
    emit(ctx, { type: 'quest_updated', questId: q.id, status: 'done' });
    logKey(ctx, 'log.quest.done', { title: q.title }, 'good');
    // currency goes to the purse and xp to everyone anyway; items to the player who met the
    // condition, else the lead
    withPlayer(ctx, r.decider ?? ctx.s.party[0], () => applyGmList(ctx, q.reward, { charge: false }));
  }
}
