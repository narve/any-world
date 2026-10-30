/**
 * Time: speed/energy rounds. The player acts when it has ≥100 energy; after its action every other
 * actor with ≥100 energy acts (fast ones several times). When the player is out of energy the round
 * ends: statuses, terrain, regen, resources, on_turn triggers, quests; then everyone gains energy
 * equal to its (hasted/slowed) speed.
 */
import { type Ctx, actorAt, emit, endGame, findFreeNear, isAlive, isPlayer, logKey, mutTile, playerActorOf, playerName, timed } from './ctx';
import type { PlayerId } from './types';
import { cheb, own, samePos } from './util';
import { energyGain, hasFlag, maxHp, maxMp } from './stats';
import { actorTurn } from './ai';
import { statusPerTurn, tickStatuses } from './statuses';
import { applyEffectList, changeResource } from './effects';
import { fireTriggers } from './triggers';
import { checkQuests } from './gm';
import { evalParty } from './conditions';
import { heal, killPlayer, lossReasonKeyed, refillFatalResources } from './combat';
import { switchesOf } from './rules';
import { regenInterval, worldClockFactor } from './difficulty';
import { closeStaleChoices } from './npc';
import { exitPending, tickExitCountdown } from './area';

export const ACT_COST = 100;
const RESOURCE_EMPTY_REPEAT = 5;
/** runWorld iterations (about two per round) before it gives control back to the player */
export const RUN_WORLD_GUARD = 2000;

/**
 * Runs other actors and rounds until some standing player can act again, the game ends or the
 * exit countdown runs out (party.ts then moves the party on). A
 * stunned player with energy to act burns it (each logs as in single player); hasted players get
 * their extra actions while the others are still out of energy.
 */
export function runWorld(ctx: Ctx): void {
  timed(ctx, 'world', () => runWorldLoop(ctx));
}

function runWorldLoop(ctx: Ctx): void {
  // 2 iterations per round at most; generous so even a 200-turn stun resolves in one step
  for (let guard = 0; ; guard++) {
    if (guard >= RUN_WORLD_GUARD) {
      // never expected (statuses and terrain always let the player act again); hand control back
      // with a visible note rather than silently burning further rounds
      logKey(ctx, 'log.turn.act_again', { player: playerName(ctx) }, 'system');
      return;
    }
    if (ctx.s.status !== 'playing') return;
    // the exit countdown ran out: runTurn moves the party on (enterArea never runs in here)
    if (exitPending(ctx)) return;
    runOthers(ctx);
    if (ctx.s.status !== 'playing') return;
    let ready = false;
    let burned = false;
    for (const id of ctx.s.party) {
      const p = playerActorOf(ctx, id);
      if (!p || !isStanding(ctx, id) || p.energy < ACT_COST) continue;
      if (hasFlag(ctx, p, 'stunned')) {
        p.energy -= ACT_COST;
        logKey(ctx, 'log.turn.stunned', { player: playerName(ctx, id) }, 'bad');
        burned = true;
      } else ready = true;
    }
    if (ready) return;
    if (burned) continue;
    // down players gain no energy, nor do those who get up this round (no burst on getting up)
    const wasDown = new Set(ctx.s.area.actors.filter((a) => a.hp <= 0 && isPlayer(ctx, a)));
    endRound(ctx);
    if (ctx.s.status !== 'playing') return;
    for (const a of ctx.s.area.actors) if (!wasDown.has(a) && (a.hp > 0 || !isPlayer(ctx, a))) a.energy = Math.min(a.energy + energyGain(ctx, a), 400);
    checkEnd(ctx);
  }
}

/**
 * Whether a player has the energy for a turn action. A party of one always has: the world only
 * hands control back once the player can act (so solo play is exactly as before parties).
 */
export function canTakeTurn(ctx: Ctx, pid: PlayerId): boolean {
  if (ctx.s.party.length < 2) return true;
  const a = playerActorOf(ctx, pid);
  return !!a && a.energy >= ACT_COST;
}

/** a player whose actor is in the area and who is not down */
export function isStanding(ctx: Ctx, pid: PlayerId): boolean {
  const ps = ctx.s.players[pid];
  if (!ps || ps.down) return false;
  const a = playerActorOf(ctx, pid);
  return !!a && a.hp > 0;
}

function runOthers(ctx: Ctx): void {
  for (let pass = 0; pass < 8; pass++) {
    let acted = false;
    for (const a of [...ctx.s.area.actors]) {
      if (ctx.s.status !== 'playing') return;
      if (isPlayer(ctx, a) || !isAlive(ctx, a) || a.energy < ACT_COST) continue;
      a.energy -= ACT_COST;
      const extra = timed(ctx, 'ai', () => actorTurn(ctx, a));
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
  // a down player skips all upkeep: item cooldowns, regeneration, resources (and, not being alive,
  // statuses, terrain and on_turn triggers)
  for (const id of s.party) {
    if (s.players[id].down) continue;
    for (const it of s.players[id].slots) if (it && it.cooldown) it.cooldown = Math.max(0, it.cooldown - 1);
  }
  // regeneration (each player's own actor)
  const ps = ctx.world.player;
  const regenEvery = regenInterval(s, ps.hpRegenEvery);
  for (const id of s.party) {
    const p = playerActorOf(ctx, id);
    if (!p || !isAlive(ctx, p)) continue;
    if (ps.mpRegenEvery > 0 && s.turn % ps.mpRegenEvery === 0 && p.mp < maxMp(ctx, p)) p.mp += 1;
    if (regenEvery > 0 && !switchesOf(ctx).noNaturalHpRegen && s.turn % regenEvery === 0) heal(ctx, p, 1);
  }
  if (s.turn % 5 === 0) for (const a of s.area.actors) if (!isPlayer(ctx, a) && a.mp < maxMp(ctx, a)) a.mp += 1;
  // custom resources: bodily, each player drains their own. In a party the world clock runs slower
  // (worldClockFactor f): the drain skips turns so it lands on about 1 turn in f, keeping whole amounts
  const clock = worldClockFactor(s);
  const drainsThisTurn = clock === 1 || Math.ceil(s.turn / clock) !== Math.ceil((s.turn - 1) / clock);
  for (const id of s.party) {
    const p = playerActorOf(ctx, id);
    if (!p || !isAlive(ctx, p)) continue;
    const res = s.players[id].resources;
    for (const r of ctx.world.resources ?? []) {
      const cur = own(res, r.id) ?? 0;
      if (r.perTurn && drainsThisTurn) changeResource(ctx, p, r.id, r.perTurn);
      if (s.status !== 'playing') return;
      if (cur === 0 && (own(res, r.id) ?? 0) === 0 && r.perTurn < 0 && s.turn % RESOURCE_EMPTY_REPEAT === 0 && r.onEmpty.length) {
        applyEffectList(ctx, r.onEmpty, p, [p], p.pos, []);
      }
    }
  }
  closeStaleChoices(ctx);
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
  reviveDown(ctx);
  checkQuests(ctx);
  checkEnd(ctx);
  tickExitCountdown(ctx);
}

/** rounds a standing teammate must spend next to a down player to get them up */
export const REVIVE_HELP_TURNS = 1;
/** rounds after which a down player gets up by themselves */
export const REVIVE_SELF_TURNS = 20;

/**
 * End of round: a down player with a standing teammate next to them (Chebyshev 1) counts a helped
 * round; after REVIVE_HELP_TURNS of them, or REVIVE_SELF_TURNS since the fall, they get up.
 */
function reviveDown(ctx: Ctx): void {
  const s = ctx.s;
  for (const id of s.party) {
    const ps = s.players[id];
    const down = ps.down;
    const a = playerActorOf(ctx, id);
    if (!down || !a) continue;
    const helped = s.party.some((o) => {
      if (o === id || !isStanding(ctx, o)) return false;
      return cheb(playerActorOf(ctx, o)!.pos, a.pos) <= 1;
    });
    if (helped) down.helpedTurns += 1;
    if (down.helpedTurns >= REVIVE_HELP_TURNS || s.turn - down.since >= REVIVE_SELF_TURNS) getUp(ctx, id, helped);
  }
}

/**
 * A down player gets up at half health with ACT_COST energy, on their tile or the nearest free one
 * (someone may have stepped onto the body), and every empty fatal resource refilled to half.
 * Waits a round when there is no free tile anywhere near.
 */
export function getUp(ctx: Ctx, pid: PlayerId, helped: boolean): void {
  const ps = ctx.s.players[pid];
  const a = playerActorOf(ctx, pid);
  if (!ps?.down || !a) return;
  if (actorAt(ctx, a.pos)) {
    const p = findFreeNear(ctx, a.pos, 12);
    if (!p) return;
    a.pos = p;
  }
  delete ps.down;
  a.hp = Math.max(1, Math.ceil(maxHp(ctx, a) / 2));
  a.energy = ACT_COST;
  refillFatalResources(ctx, ps);
  emit(ctx, { type: 'revived', playerId: pid, actorId: a.id, helped });
  logKey(ctx, 'log.party.up', { player: ps.name }, 'good');
}

/**
 * win/lose: a player at 0 hp who is not down (a party of one loses; in a party it is a fall like
 * any other), everyone down, goal.lose, goal.win. Goals are evaluated for the whole party per
 * condition leaf (conditions.ts evalParty).
 */
export function checkEnd(ctx: Ctx): void {
  const s = ctx.s;
  if (s.status !== 'playing') return;
  for (const id of s.party) {
    const a = playerActorOf(ctx, id);
    if (a && a.hp <= 0 && !s.players[id].down) {
      if (s.party.length > 1) {
        killPlayer(ctx, a, undefined);
        if (s.status !== 'playing') return;
        continue;
      }
      const lr = lossReasonKeyed(ctx, undefined, s.players[id]);
      endGame(ctx, 'lost', lr.text, lr);
      return;
    }
  }
  if (s.party.every((id) => s.players[id].down)) {
    // killPlayer ends the run on the last fall; this only guards states that got here otherwise
    const lr = lossReasonKeyed(ctx, undefined, s.players[s.party[0]]);
    endGame(ctx, 'lost', lr.text, lr);
    return;
  }
  if (evalParty(ctx, ctx.world.goal.win, 'win')) {
    endGame(ctx, 'won', ctx.world.goal.summary);
    return;
  }
  if (ctx.world.goal.lose && evalParty(ctx, ctx.world.goal.lose, 'lose')) {
    endGame(ctx, 'lost', ctx.world.goal.summary);
  }
}
