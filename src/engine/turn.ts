/**
 * Time: speed/energy rounds. The player acts when it has ≥100 energy; after its action every other
 * actor with ≥100 energy acts (fast ones several times). When the player is out of energy the round
 * ends: statuses, terrain, regen, resources, on_turn triggers, quests; then everyone gains energy
 * equal to its (hasted/slowed) speed.
 */
import { type Ctx, actorAt, emit, endGame, isAlive, isPlayer, logKey, mutTile, playerActor } from './ctx';
import { own, samePos } from './util';
import { energyGain, hasFlag, maxHp, maxMp } from './stats';
import { actorTurn } from './ai';
import { statusPerTurn, tickStatuses } from './statuses';
import { applyEffectList, changeResource } from './effects';
import { fireTriggers } from './triggers';
import { checkQuests } from './gm';
import { evalCondition } from './conditions';
import { heal } from './combat';
import { switchesOf } from './rules';
import { lossReasonKeyed } from './combat';
import { regenInterval } from './difficulty';

export const ACT_COST = 100;
const RESOURCE_EMPTY_REPEAT = 5;
/** runWorld iterations (about two per round) before it gives control back to the player */
export const RUN_WORLD_GUARD = 2000;

/** runs other actors and rounds until the player can act again (or the game ends) */
export function runWorld(ctx: Ctx): void {
  // 2 iterations per round at most; generous so even a 200-turn stun resolves in one step
  for (let guard = 0; ; guard++) {
    if (guard >= RUN_WORLD_GUARD) {
      // never expected (statuses and terrain always let the player act again); hand control back
      // with a visible note rather than silently burning further rounds
      logKey(ctx, 'log.turn.act_again', { player: ctx.world.player.name }, 'system');
      return;
    }
    if (ctx.s.status !== 'playing') return;
    runOthers(ctx);
    if (ctx.s.status !== 'playing') return;
    const p = playerActor(ctx);
    if (p.energy >= ACT_COST) {
      if (hasFlag(ctx, p, 'stunned')) {
        p.energy -= ACT_COST;
        logKey(ctx, 'log.turn.stunned', { player: ctx.world.player.name }, 'bad');
        continue;
      }
      return;
    }
    endRound(ctx);
    if (ctx.s.status !== 'playing') return;
    for (const a of ctx.s.area.actors) a.energy = Math.min(a.energy + energyGain(ctx, a), 400);
    checkEnd(ctx);
  }
}

function runOthers(ctx: Ctx): void {
  for (let pass = 0; pass < 8; pass++) {
    let acted = false;
    for (const a of [...ctx.s.area.actors]) {
      if (ctx.s.status !== 'playing') return;
      if (isPlayer(ctx, a) || !isAlive(ctx, a) || a.energy < ACT_COST) continue;
      a.energy -= ACT_COST;
      const extra = actorTurn(ctx, a);
      if (extra > 0) a.energy -= extra;
      acted = true;
      checkEnd(ctx);
    }
    if (!acted) return;
  }
}

/** end-of-round upkeep for every actor */
export function endRound(ctx: Ctx): void {
  const s = ctx.s;
  s.turn += 1;
  const map = s.area.map;
  const actors = [...s.area.actors];
  const expiredBy = new Map<string, Set<string>>();
  for (const a of actors) {
    if (!isAlive(ctx, a)) continue;
    statusPerTurn(ctx, a);
    if (s.status !== 'playing') return;
    if (!isAlive(ctx, a)) continue;
    expiredBy.set(a.id, tickStatuses(ctx, a));
  }
  // terrain underfoot. Its statuses never refresh: one the actor still has (from any source) or
  // that just expired this round is not applied again, so a stun or root of any length always
  // runs out and leaves a round to act in (step off) before the terrain applies it again.
  for (const a of actors) {
    if (!isAlive(ctx, a)) continue;
    const t = map.tiles[a.pos.y * map.width + a.pos.x];
    if (!t?.terrain) continue;
    const td = ctx.ix.terrains.get(t.terrain);
    if (!td || !td.onStand.length) continue;
    const skip = expiredBy.get(a.id) ?? new Set<string>();
    const has = new Set(a.statuses.map((st) => st.id));
    const effects = td.onStand.filter((e) => !(e.type === 'apply_status' && (skip.has(e.status) || has.has(e.status))));
    const prevCause = ctx.harmCause;
    ctx.harmCause = { terrain: td.id };
    try {
      applyEffectList(ctx, effects, a, [a], a.pos, []);
    } finally {
      ctx.harmCause = prevCause;
    }
    if (s.status !== 'playing') return;
  }
  for (const a of s.area.actors) {
    a.tempMods = a.tempMods.filter((m) => --m.turnsLeft > 0);
    for (const k of Object.keys(a.cooldowns)) a.cooldowns[k] = Math.max(0, a.cooldowns[k] - 1);
    a.hp = Math.min(a.hp, maxHp(ctx, a));
    a.mp = Math.min(a.mp, maxMp(ctx, a));
  }
  for (const it of s.player.slots) if (it && it.cooldown) it.cooldown = Math.max(0, it.cooldown - 1);
  // regeneration
  const p = playerActor(ctx);
  const ps = ctx.world.player;
  if (ps.mpRegenEvery > 0 && s.turn % ps.mpRegenEvery === 0 && p.mp < maxMp(ctx, p)) p.mp += 1;
  const regenEvery = regenInterval(s, ps.hpRegenEvery);
  if (regenEvery > 0 && !switchesOf(ctx).noNaturalHpRegen && s.turn % regenEvery === 0) heal(ctx, p, 1);
  if (s.turn % 5 === 0) for (const a of s.area.actors) if (!isPlayer(ctx, a) && a.mp < maxMp(ctx, a)) a.mp += 1;
  // custom resources
  for (const r of ctx.world.resources ?? []) {
    const cur = own(s.player.resources, r.id) ?? 0;
    if (r.perTurn) changeResource(ctx, p, r.id, r.perTurn);
    if (s.status !== 'playing') return;
    if (cur === 0 && (own(s.player.resources, r.id) ?? 0) === 0 && r.perTurn < 0 && s.turn % RESOURCE_EMPTY_REPEAT === 0 && r.onEmpty.length) {
      applyEffectList(ctx, r.onEmpty, p, [p], p.pos, []);
    }
  }
  // on_turn triggers
  for (const a of [...s.area.actors]) {
    if (s.status !== 'playing') return;
    if (isAlive(ctx, a)) fireTriggers(ctx, a, 'on_turn', { pos: a.pos });
  }
  // temporary terrain
  const changed: { x: number; y: number }[] = [];
  for (let i = 0; i < map.tiles.length; i++) {
    if (map.tiles[i].terrainTtl === undefined) continue;
    const t = mutTile(ctx, i);
    t.terrainTtl = (t.terrainTtl ?? 1) - 1;
    if (t.terrainTtl > 0) continue;
    const pos = { x: i % map.width, y: Math.floor(i / map.width) };
    const under = t.terrainUnder;
    const underDef = under ? ctx.ix.terrains.get(under.terrain) : undefined;
    // a covered blocking terrain (a chest, a pillar) waits until nobody and nothing is on the tile
    if (underDef && underDef.walkable === false && (actorAt(ctx, pos) || s.area.items.some((fi) => samePos(fi.pos, pos)))) {
      t.terrainTtl = 1;
      continue;
    }
    delete t.terrainTtl;
    if (under) {
      t.terrain = under.terrain;
      if (under.interacted) t.interacted = true;
      else delete t.interacted;
      delete t.terrainUnder;
    } else {
      delete t.terrain;
      delete t.interacted;
    }
    changed.push(pos);
  }
  if (changed.length) emit(ctx, { type: 'terrain_changed', positions: changed });
  checkQuests(ctx);
  checkEnd(ctx);
}

/** win/lose: death, empty fatal resources, goal.lose, goal.win */
export function checkEnd(ctx: Ctx): void {
  const s = ctx.s;
  if (s.status !== 'playing') return;
  const p = playerActor(ctx);
  if (p.hp <= 0) {
    const lr = lossReasonKeyed(ctx);
    endGame(ctx, 'lost', lr.text, lr);
    return;
  }
  const cc = { self: p };
  if (evalCondition(ctx, ctx.world.goal.win, cc)) {
    endGame(ctx, 'won', ctx.world.goal.summary);
    return;
  }
  if (ctx.world.goal.lose && evalCondition(ctx, ctx.world.goal.lose, cc)) {
    endGame(ctx, 'lost', ctx.world.goal.summary);
  }
}
