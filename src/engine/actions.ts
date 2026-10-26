/** Player action dispatch: validation first (no state change when invalid), then the action. */
import type { Dir, PlayerAction, Pos } from './types';
import {
  type Ctx,
  actorAt,
  actorDef,
  actorName,
  emit,
  findActor,
  isAlive,
  isPlayer,
  log,
  logKey,
  me,
  moveCost,
  mutTile,
  passable,
  partyActors,
  playerActor,
  playerName,
} from './ctx';
import {
  type ActionOutcome,
  displayItemName,
  doDrop,
  doEquip,
  doMoveItem,
  doPickup,
  doUnequip,
  doUse,
  done,
  free,
  invalid,
} from './inventory';
import { attackOf, inAttackRange, performAttack } from './combat';
import { hasFlag, side } from './stats';
import { isVisibleToPlayer, runAction } from './effects';
import { moveActor } from './actors';
import { enterArea, lockedReason, transitionFailure } from './area';
import { canTalkTo, doChooseOption, doPersuade, doTalk, talkingWith } from './npc';
import { choosePerk } from './progression';
import { DIR_LIST, addDir, cheb, isValidPos, samePos, tileAt } from './util';

export function doPlayerAction(ctx: Ctx, action: PlayerAction): ActionOutcome {
  if (!action || typeof action !== 'object' || typeof (action as { type?: unknown }).type !== 'string') return invalid('malformed action');
  const s = ctx.s;
  // a pending perk choice comes first, then any open dialogue/GM choice
  if (me(ctx).pendingPerkChoice) {
    if (action.type !== 'choose_perk') return invalid('choose a perk first');
  } else if (me(ctx).pendingChoice && action.type !== 'choose_option') return invalid('make a choice first');
  switch (action.type) {
    case 'move':
      return doMove(ctx, action.dir);
    case 'attack':
      return doAttack(ctx, action.targetId);
    case 'wait':
      return done();
    case 'use':
      if (action.target !== undefined && !isValidPos(action.target)) return invalid('bad target');
      return doUse(ctx, action.slot, action.target);
    case 'equip':
      return doEquip(ctx, action.slot);
    case 'unequip':
      return doUnequip(ctx, action.slot);
    case 'move_item':
      return doMoveItem(ctx, action.from, action.to);
    case 'drop':
      return doDrop(ctx, action.slot);
    case 'pickup':
      return doPickup(ctx);
    case 'transition':
      return doTransition(ctx);
    case 'talk':
      return doTalk(ctx, action.targetId);
    case 'persuade':
      return doPersuade(ctx, action.targetId);
    case 'search':
      return doSearch(ctx);
    case 'toggle_sneak':
      if (!ctx.world.verbs.sneak) return invalid('sneaking is not possible here');
      me(ctx).sneaking = !me(ctx).sneaking;
      logKey(ctx, me(ctx).sneaking ? 'log.sneak.on' : 'log.sneak.off', { player: playerName(ctx) }, 'info');
      return free();
    case 'choose_perk': {
      const err = choosePerk(ctx, action.perkId);
      return err ? invalid(err) : free();
    }
    case 'choose_option':
      return doChooseOption(ctx, action.index);
    case 'interact':
      if (!isValidPos(action.pos)) return invalid('bad position');
      return doInteract(ctx, action.pos);
    default:
      return invalid('unknown action');
  }
}

function doMove(ctx: Ctx, dirIn: Dir): ActionOutcome {
  if (!DIR_LIST.includes(dirIn)) return invalid('bad direction');
  const p = playerActor(ctx);
  let dir = dirIn;
  const confused = hasFlag(ctx, p, 'confused');
  if (confused && ctx.rng.chance(0.5)) dir = ctx.rng.pick(DIR_LIST);
  const to = addDir(p.pos, dir);
  const map = ctx.s.area.map;
  const tile = tileAt(map, to.x, to.y);
  const other = tile ? actorAt(ctx, to) : undefined;
  if (other && isPlayer(ctx, other)) {
    // walking into a teammate swaps places (as with allies), so nobody blocks a corridor
    if (hasFlag(ctx, p, 'rooted')) return invalid('you cannot move');
    const from = { ...p.pos };
    other.pos = from;
    emit(ctx, { type: 'moved', actorId: other.id, from: to, to: from });
    moveActor(ctx, p, to);
    return done(Math.round(100 * moveCost(ctx, to)));
  }
  if (other) {
    if (side(ctx, other) === 'H') return attackTarget(ctx, other, true);
    // allies, and NPCs you've already spoken to, step aside (so nobody can block a corridor)
    const talkFirst = canTalkTo(ctx, other) && !other.talkedTo && !talkingWith(ctx, other);
    if (other.allyOf === p.id || (!talkFirst && !confused)) {
      if (hasFlag(ctx, p, 'rooted')) return invalid('you cannot move');
      const from = { ...p.pos };
      other.pos = from;
      emit(ctx, { type: 'moved', actorId: other.id, from: to, to: from });
      moveActor(ctx, p, to);
      return done(Math.round(100 * moveCost(ctx, to)));
    }
    if (talkFirst) return doTalk(ctx, other.id);
    logKey(ctx, 'log.stumble', { player: playerName(ctx) }, 'info');
    return done();
  }
  if (!tile || !passable(ctx, to.x, to.y)) {
    if (confused && dir !== dirIn) {
      logKey(ctx, 'log.stumble', { player: playerName(ctx) }, 'info');
      return done();
    }
    return invalid('blocked');
  }
  if (hasFlag(ctx, p, 'rooted')) return invalid('you cannot move');
  if (tile.kind === 'door') {
    mutTile(ctx, to.y * map.width + to.x).kind = 'door_open';
    emit(ctx, { type: 'terrain_changed', positions: [{ ...to }] });
    return done();
  }
  moveActor(ctx, p, to);
  const here = ctx.s.area.items.filter((fi) => samePos(fi.pos, to));
  if (here.length) {
    const names = here.slice(0, 3).map((fi) => displayItemName(ctx, fi.item.defId));
    logKey(ctx, here.length > 3 ? 'log.here_more' : 'log.here', { items: names.join(', ') }, 'info');
  }
  if (me(ctx).sneaking) return done(Math.round(100 * moveCost(ctx, to)) + 25);
  return done(Math.round(100 * moveCost(ctx, to)));
}

/** why the player can't attack this actor (null = can) */
export function attackFailure(ctx: Ctx, target: ReturnType<typeof findActor>, bump = false): string | null {
  const p = playerActor(ctx);
  if (!target || !isAlive(ctx, target) || isPlayer(ctx, target)) return 'no target';
  if (!bump && !isVisibleToPlayer(ctx, target)) return 'you cannot see that';
  if (hasFlag(ctx, p, 'afraid')) return 'too afraid to fight';
  if (hasFlag(ctx, p, 'charmed') && p.statuses.some((st) => st.sourceId === target.id && ctx.ix.statuses.get(st.id)?.flags.includes('charmed')))
    return `you can't bring yourself to fight ${actorName(ctx, target)}`;
  const info = attackOf(ctx, p)!;
  if (!inAttackRange(ctx, p, target, info.attack)) {
    if (bump && cheb(p.pos, target.pos) === 1) return null;
    return 'out of range';
  }
  return null;
}

function attackTarget(ctx: Ctx, target: NonNullable<ReturnType<typeof findActor>>, bump: boolean): ActionOutcome {
  const err = attackFailure(ctx, target, bump);
  if (err) return invalid(err);
  const p = playerActor(ctx);
  let info = attackOf(ctx, p)!;
  // bumping with a ranged weapon that can't reach diagonally etc. falls back to unarmed
  if (!inAttackRange(ctx, p, target, info.attack)) info = { attack: ctx.world.player.unarmed, slot: null };
  performAttack(ctx, p, target, info);
  return done();
}

function doAttack(ctx: Ctx, targetId: string): ActionOutcome {
  const t = findActor(ctx, targetId);
  if (!t) return invalid('no target');
  return attackTarget(ctx, t, false);
}

function doTransition(ctx: Ctx): ActionOutcome {
  const err = transitionFailure(ctx);
  if (err) {
    if (err === lockedReason(ctx)) logKey(ctx, 'log.transition.locked', { transition: ctx.world.areas[ctx.s.area.index].transitionName }, 'warning');
    return invalid(err);
  }
  ctx.s.stats.areasCleared += 1;
  log(ctx, ctx.world.areas[ctx.s.area.index].transitionName, 'system');
  // the whole party moves on together (MP1 B3 adds the exit countdown)
  enterArea(ctx, ctx.s.area.index + 1);
  for (const p of partyActors(ctx)) p.energy = Math.max(p.energy, 100);
  return done();
}

function doSearch(ctx: Ctx): ActionOutcome {
  if (!ctx.world.verbs.search) return invalid('searching is not possible here');
  const p = playerActor(ctx);
  const map = ctx.s.area.map;
  const seen = me(ctx).seen;
  let found = 0;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const x = p.pos.x + dx;
      const y = p.pos.y + dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const i = y * map.width + x;
      if (seen[i] === 0) seen[i] = 1;
      const t = map.tiles[i];
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= 1 && t.terrain && !t.interacted) {
        const td = ctx.ix.terrains.get(t.terrain);
        if (td?.interact) {
          logKey(ctx, 'log.search.terrain', { terrain: td.name, description: td.description }, 'info');
          found++;
        }
      }
    }
  for (const a of ctx.s.area.actors) {
    if (isPlayer(ctx, a) || a.ai.alerted || cheb(a.pos, p.pos) > 3) continue;
    const def = actorDef(ctx, a);
    if (side(ctx, a) === 'H' && (def?.behaviour.type === 'ambusher' || hasFlag(ctx, a, 'invisible'))) {
      a.ai.alerted = true;
      a.ai.lastSeen = { ...p.pos };
      logKey(ctx, 'log.search.spot', { player: playerName(ctx), target: actorName(ctx, a) }, 'warning');
      found++;
    }
  }
  if (!found) logKey(ctx, 'log.search.nothing', {}, 'info');
  return done();
}

function doInteract(ctx: Ctx, pos: Pos): ActionOutcome {
  const p = playerActor(ctx);
  const map = ctx.s.area.map;
  const t = tileAt(map, pos.x, pos.y);
  if (!t) return invalid('nothing there');
  if (cheb(p.pos, pos) > 1) return invalid('too far away');
  if (t.kind === 'door' || t.kind === 'door_open') {
    if (t.kind === 'door_open' && (actorAt(ctx, pos) || ctx.s.area.items.some((fi) => samePos(fi.pos, pos)))) return invalid('something is in the way');
    mutTile(ctx, pos.y * map.width + pos.x).kind = t.kind === 'door' ? 'door_open' : 'door';
    emit(ctx, { type: 'terrain_changed', positions: [{ ...pos }] });
    return done();
  }
  const td = t.terrain ? ctx.ix.terrains.get(t.terrain) : undefined;
  if (!td?.interact) return invalid('nothing to do there');
  if (t.interacted) return invalid(`${td.name}: nothing more to find`);
  logKey(ctx, 'log.interact.use', { player: playerName(ctx), terrain: td.name }, 'info');
  const terrainId = t.terrain;
  const res = runAction(ctx, td.interact, p, { targetPos: pos });
  // the tile is used up when its action ran, or when a pure luck roll failed (one roll per tile);
  // a requirement that isn't met yet (a key, a flag, a stat) leaves it for later
  const luckOnly = td.interact.condition?.type === 'chance';
  if (res.ok && (!res.conditionFailed || luckOnly)) {
    // the action may have changed the tile's terrain: mark the used terrain where it now is
    // (still there, or covered by temporary terrain); a permanent replacement starts fresh
    // (re-read: the action may have replaced the tile object under copy-on-write)
    const now = mutTile(ctx, pos.y * map.width + pos.x);
    if (now.terrain === terrainId) now.interacted = true;
    else if (now.terrainUnder && now.terrainUnder.terrain === terrainId) now.terrainUnder.interacted = true;
  }
  if (res.conditionFailed || !res.ok) logKey(ctx, 'log.interact.nothing', {}, 'info');
  return done();
}

