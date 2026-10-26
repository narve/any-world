/** Legal player actions for bots and UI hints (every action listed here is accepted by step). */
import type { PlayerAction } from './types';
import { TOTAL_SLOTS } from './types';
import { type Ctx, actorAt, isPlayer, me, passable, playerActor, playerActorOf } from './ctx';
import { firstFreeSlot, equipSlotOf, equippedKindOf, requiresFailure, useFailure } from './inventory';
import { POSITIONAL_SHAPES, autoTarget, isVisibleToPlayer } from './effects';
import { attackFailure } from './actions';
import { canTalkTo, talkingWith, TALK_RANGE } from './npc';
import { canTakeTurn } from './turn';
import { optionPrice } from './gm';
import { transitionFailure } from './area';
import { hasFlag, side } from './stats';
import { DIR_LIST, addDir, cheb, samePos, tileAt } from './util';
import { requiredDefeats } from './goals';
import type { ActorInstance } from './types';

/**
 * Whether the run still needs this (non-hostile) actor defeated: its def id, or an earlier form
 * of it, is named by an actor_defeated the goal, a lock or an active quest has not had yet.
 */
function defeatRequired(required: Set<string>, a: ActorInstance): boolean {
  if (!required.size) return false;
  if (required.has(a.defId)) return true;
  return (a.formerDefIds ?? []).some((id) => required.has(id));
}

export function computeLegalActions(ctx: Ctx): PlayerAction[] {
  const s = ctx.s;
  if (s.status !== 'playing') return [];
  const ps = me(ctx);
  if (ps.down || !playerActorOf(ctx, ps.id)) return [];
  if (ps.pendingPerkChoice) return ps.pendingPerkChoice.map((perkId) => ({ type: 'choose_perk', perkId }));
  const pc = ps.pendingChoice;
  if (pc) {
    const all = pc.options.map((_, index) => ({ type: 'choose_option' as const, index }));
    const affordable = all.filter((a) => optionPrice(pc.options[a.index].actions) <= s.purse);
    // with nothing affordable every pick declines the choice (see doChooseOption)
    return affordable.length ? affordable : all;
  }
  const out: PlayerAction[] = [];
  const p = playerActor(ctx);
  // out of energy (a teammate is hasted): only the free actions
  if (!canTakeTurn(ctx, ps.id)) {
    for (const a of s.area.actors) {
      if (isPlayer(ctx, a) || a.hp <= 0 || cheb(a.pos, p.pos) > TALK_RANGE || !canTalkTo(ctx, a) || talkingWith(ctx, a)) continue;
      if (isVisibleToPlayer(ctx, a) || cheb(a.pos, p.pos) <= 1) out.push({ type: 'talk', targetId: a.id });
    }
    if (ctx.world.verbs.sneak) out.push({ type: 'toggle_sneak' });
    return out;
  }
  const map = s.area.map;
  const rooted = hasFlag(ctx, p, 'rooted');
  for (const dir of DIR_LIST) {
    const to = addDir(p.pos, dir);
    const t = tileAt(map, to.x, to.y);
    if (!t) continue;
    const other = actorAt(ctx, to);
    if (other && !isPlayer(ctx, other)) {
      if (side(ctx, other) === 'H') {
        if (!attackFailure(ctx, other, true)) out.push({ type: 'move', dir });
      } else if (canTalkTo(ctx, other) && !other.talkedTo && !talkingWith(ctx, other)) {
        out.push({ type: 'move', dir });
      } else if (!rooted) out.push({ type: 'move', dir });
      continue;
    }
    if (passable(ctx, to.x, to.y) && !rooted) out.push({ type: 'move', dir });
  }
  out.push({ type: 'wait' });
  const required = requiredDefeats(ctx);
  if (s.area.items.some((fi) => samePos(fi.pos, p.pos)) && firstFreeSlot(ctx) >= 0) out.push({ type: 'pickup' });
  if (!transitionFailure(ctx)) out.push({ type: 'transition' });
  for (const a of s.area.actors) {
    if (isPlayer(ctx, a) || a.hp <= 0) continue;
    if (!isVisibleToPlayer(ctx, a) && cheb(a.pos, p.pos) > 1) continue;
    // hostiles, and anyone else the run needs defeated (a persuaded rival the goal still names):
    // step() accepts an attack on a neutral or friendly actor (it provokes them)
    if ((side(ctx, a) === 'H' || defeatRequired(required, a)) && !attackFailure(ctx, a)) out.push({ type: 'attack', targetId: a.id });
    if (cheb(a.pos, p.pos) <= TALK_RANGE) {
      if (canTalkTo(ctx, a) && !talkingWith(ctx, a)) out.push({ type: 'talk', targetId: a.id });
      if (ctx.world.verbs.persuade && !a.allyOf) out.push({ type: 'persuade', targetId: a.id });
    }
  }
  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    const it = me(ctx).slots[slot];
    if (!it) continue;
    const def = ctx.ix.items.get(it.defId);
    if (!def) continue;
    // use (with an automatic target for aimed items)
    let target;
    if (def.onUse && def.useMode !== 'passive' && POSITIONAL_SHAPES.has(def.onUse.targeting.shape) && def.onUse.targeting.affects !== 'self_only') {
      target = autoTarget(ctx, p, def.onUse.targeting, def.onUse.effects)?.pos;
    }
    if (!useFailure(ctx, slot, target)) out.push(target ? { type: 'use', slot, target: { ...target } } : { type: 'use', slot });
    const kind = equipSlotOf(def);
    if (kind) {
      if (equippedKindOf(ctx, slot)) out.push({ type: 'unequip', slot });
      else if (!requiresFailure(ctx, def)) out.push({ type: 'equip', slot });
    }
    out.push({ type: 'drop', slot });
    const free = firstFreeSlot(ctx, slot >= 8);
    if (free >= 0) out.push({ type: 'move_item', from: slot, to: free });
  }
  if (ctx.world.verbs.search) out.push({ type: 'search' });
  if (ctx.world.verbs.sneak) out.push({ type: 'toggle_sneak' });
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const pos = { x: p.pos.x + dx, y: p.pos.y + dy };
      const t = tileAt(map, pos.x, pos.y);
      if (!t) continue;
      if (t.terrain && !t.interacted && ctx.ix.terrains.get(t.terrain)?.interact) out.push({ type: 'interact', pos });
      else if (t.kind === 'door') out.push({ type: 'interact', pos });
    }
  return out;
}
