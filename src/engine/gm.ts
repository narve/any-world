/**
 * GM actions applied to the game state. Every action costs GM_ACTION_COST from the area budget
 * (GM_BUDGET_PER_AREA); actions beyond the budget and actions with invalid references are skipped
 * with a system log entry. Also quests (start, completion, rewards).
 */
import type { GmAction, GmLeafAction } from '../schema/gm';
import type { Effect } from '../schema/world';
import { GM_ACTION_COST } from '../schema/gm';
import type { ActorInstance, PendingChoice, Pos, Quest } from './types';
import { type Ctx, actorName, emit, findActor, findFreeNear, isAlive, isPlayer, log, playerActor } from './ctx';
import { spawnActor } from './actors';
import { displayItemName, dropItemAt, giveItem } from './inventory';
import { applyEffectList, isVisibleToPlayer } from './effects';
import { reveal } from './knowledge';
import { grantXp } from './progression';
import { evalCondition } from './conditions';
import { side } from './stats';
import { cheb, dist2 } from './util';

function skip(ctx: Ctx, a: GmAction, why: string): void {
  log(ctx, `GM ${a.type} skipped: ${why}`, 'system');
}

function nearPos(ctx: Ctx, near: 'player' | 'random' | 'exit'): Pos | null {
  const map = ctx.s.area.map;
  if (near === 'player') return findFreeNear(ctx, playerActor(ctx).pos, 6, (q) => cheb(q, playerActor(ctx).pos) < 2);
  if (near === 'exit') return findFreeNear(ctx, map.exit, 6);
  const cands: Pos[] = [];
  const p = playerActor(ctx).pos;
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++) {
      const t = map.tiles[y * map.width + x];
      if (t.kind !== 'floor') continue;
      const q = { x, y };
      if (cheb(q, p) < 5) continue;
      cands.push(q);
    }
  ctx.rng.shuffle(cands);
  for (const q of cands.slice(0, 50)) {
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
  return actions.reduce((n, a) => n + (GM_ACTION_COST[a.type] ?? 0), 0);
}

/**
 * Budget cost of one GM action. An offer_choice costs its own price plus the most expensive
 * option: the budget for the goods is reserved when the offer is made (the chosen option is then
 * applied without charging, and the unused part of the reservation is refunded), so other GM hooks
 * that spend the budget while the offer is open can never leave a paid option half-applied.
 */
export function gmActionCost(a: GmAction): number {
  const base = GM_ACTION_COST[a.type] ?? 0;
  if (a.type !== 'offer_choice') return base;
  return base + Math.max(0, ...a.options.map((o) => leafCost(o.actions.filter((x) => x.type !== ('offer_choice' as string)))));
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
    default:
      return a.type in GM_ACTION_COST ? null : 'unknown type';
  }
}

export interface GmApplyOpts {
  /** charge the area GM budget (false for engine-built dialogue options and quest rewards) */
  charge: boolean;
}

export function applyGmList(ctx: Ctx, actions: readonly GmAction[], opts: GmApplyOpts): void {
  for (const a of actions) {
    if (ctx.s.status !== 'playing') return;
    if (!a || typeof a !== 'object' || !(a.type in GM_ACTION_COST)) {
      log(ctx, 'GM action skipped: unknown type', 'system');
      continue;
    }
    const cost = gmActionCost(a);
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
      if (a.type === 'offer_choice' && ctx.s.pendingChoice?.kind === 'gm_offer') ctx.s.pendingChoice.reservedBudget = cost - GM_ACTION_COST.offer_choice;
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
      let n = 0;
      for (let i = 0; i < (a.count ?? 1); i++) {
        const p = nearPos(ctx, a.near ?? 'random');
        if (!p) break;
        const s = spawnActor(ctx, a.actor, p, { randomEnergy: true });
        if (s) n++;
      }
      if (!n) return 'nowhere to place it';
      log(ctx, `${ix.actors.get(a.actor)!.name}${n > 1 ? ` ×${n}` : ''} appears.`, 'warning');
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
      log(ctx, `${actorName(ctx, actor)} is now ${a.faction}.`, a.faction === 'hostile' ? 'bad' : 'good');
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
      log(ctx, `New: ${q.title}`, 'gm');
      return null;
    }
    case 'trade': {
      const actor = resolveActor(ctx, a.actorId);
      if (!actor) return `no actor "${a.actorId}"`;
      if (ctx.s.pendingChoice) return 'a choice is already open';
      const items = a.items.filter((x) => ix.items.has(x.item));
      if (!items.length) return 'no valid items';
      ctx.s.pendingChoice = {
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
      return null;
    }
    case 'currency':
      ctx.s.player.currency = Math.max(0, ctx.s.player.currency + a.amount);
      if (a.amount) log(ctx, `${a.amount > 0 ? '+' : ''}${a.amount} ${ctx.world.vocabulary.currency}`, a.amount > 0 ? 'loot' : 'info');
      return null;
    case 'grant_xp':
      grantXp(ctx, a.amount);
      return null;
    case 'offer_choice': {
      if (ctx.s.pendingChoice) return 'a choice is already open';
      // an option is offered whole or not at all: one naming a missing item/actor/status could
      // take the price and fail to deliver, so it is left out
      const options: PendingChoice['options'] = [];
      for (const o of a.options) {
        const actions = o.actions.filter((x) => x.type !== ('offer_choice' as string));
        if (actions.some((x) => leafRefError(ctx, x))) continue;
        options.push({ label: o.label, actions });
      }
      if (!options.length) return 'no valid options';
      // there is always a way out: a choice whose every option costs currency could otherwise
      // become impossible to resolve (and every other player action waits for it)
      if (!options.some((o) => optionPrice(o.actions) === 0)) options.push({ label: DECLINE_LABEL, actions: [], tag: 'decline' });
      ctx.s.pendingChoice = { kind: 'gm_offer', prompt: a.prompt, options };
      log(ctx, a.prompt, 'gm');
      return null;
    }
  }
  return 'unsupported';
}

/** marks active quests done when their condition holds and pays rewards */
export function checkQuests(ctx: Ctx): void {
  for (const q of ctx.s.quests) {
    if (q.status !== 'active') continue;
    if (!evalCondition(ctx, q.complete, { self: playerActor(ctx) })) continue;
    q.status = 'done';
    emit(ctx, { type: 'quest_updated', questId: q.id, status: 'done' });
    log(ctx, `Done: ${q.title}`, 'good');
    applyGmList(ctx, q.reward, { charge: false });
  }
}
