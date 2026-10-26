/**
 * Combat: to-hit (d20 + stat mod vs AC, natural 20 crits, natural 1 misses; the player's own
 * attacks only miss on a natural 1-2, PLAYER_HIT_CHANCE), damage with resistances, death, loot,
 * xp and durability.
 */
import type { Attack } from '../schema/world';
import type { ActorInstance, PlayerState } from './types';
import {
  type Ctx,
  actorDef,
  actorName,
  damageTypeName,
  emit,
  endGame,
  findActor,
  isAlive,
  isPlayer,
  log,
  logKey,
  me,
  playerOf,
  statusName,
  withPlayer,
} from './ctx';
import { LOW_HP_FRACTION, getStat, maxHp, side, statMod } from './stats';
import { evalAmount, los } from './effects';
import { fireDefTriggers, fireTriggers } from './triggers';
import { defChain } from './actors';
import { grantXp } from './progression';
import { damageEquipped, dropItemAt } from './inventory';
import { cheb, own } from './util';
import { END_REASON_KEYS, type EndReasonKey, type LogParams, renderTemplate } from './log-keys';
import { withinReach } from './fov';
import { playerSeesTile } from './vision';
import { switchesOf } from './rules';
import { profileOf } from './difficulty';

export interface AttackInfo {
  attack: Attack;
  /** player weapon slot used, if any */
  slot: number | null;
}

/**
 * The attack of a hostile (non-NPC) actor or recruited ally whose def has none. Its `verb` is only
 * the English fallback: log lines of this attack use the *_default keys, which carry no verb param.
 */
export const DEFAULT_ACTOR_ATTACK: Attack = {
  name: 'Strike',
  verb: 'strikes',
  damage: { base: 0, dice: '1d3' },
  damageType: 'physical',
  range: 1,
  accuracyStat: 'dex',
};

/** the attack an actor uses; null if it has none (most NPCs) */
export function attackOf(ctx: Ctx, a: ActorInstance): AttackInfo | null {
  const ps = playerOf(ctx, a);
  if (ps) {
    const slot = ps.equipped.weapon;
    if (slot !== null) {
      const it = ps.slots[slot];
      const def = it ? ctx.ix.items.get(it.defId) : undefined;
      if (def?.weapon) return { attack: def.weapon, slot };
    }
    return { attack: ctx.world.player.unarmed, slot: null };
  }
  const def = actorDef(ctx, a);
  if (def?.attack) return { attack: def.attack, slot: null };
  if (def && !def.npc && a.faction === 'hostile') return { attack: DEFAULT_ACTOR_ATTACK, slot: null };
  if (a.allyOf && def && !def.npc) return { attack: DEFAULT_ACTOR_ATTACK, slot: null };
  return null;
}

/**
 * Can `a` hit `t` with its attack right now. Melee reaches the 8 neighbours; ranged attacks reach
 * `range` steps in any direction (withinReach, the same count as movement and ability targeting)
 * with line of sight. Perception is symmetric: nobody shoots the player from beyond arm's reach
 * while standing where the player can't see.
 */
export function inAttackRange(ctx: Ctx, a: ActorInstance, t: ActorInstance, atk: Attack): boolean {
  const d = cheb(a.pos, t.pos);
  if (d < 1) return false;
  if (atk.range <= 1) return d <= 1;
  if (!withinReach(a.pos, t.pos, atk.range) || !los(ctx, a.pos, t.pos)) return false;
  if (d > 1 && isPlayer(ctx, t) && !isPlayer(ctx, a) && !playerSeesTile(ctx, a.pos)) return false;
  return true;
}

export interface AttackResult {
  hit: boolean;
  crit: boolean;
  damage: number;
  roll: number;
}

/**
 * The player's attacks land this often whatever the target's armour (natural 20 still crits). Long
 * streaks of misses at level 1 read as the game cheating (docs/playtest/FABLE-GAMEPLAY-REVIEW.md
 * §1.1); hostiles keep the full d20 roll so armour and evasion still matter on the player's side.
 */
export const PLAYER_HIT_CHANCE = 0.9;
/** the highest d20 roll that still misses for the player (2 → 18 of 20 = 90 %) */
const PLAYER_MISS_MAX = Math.round(20 * (1 - PLAYER_HIT_CHANCE));

/** to-hit bonus for an attack */
export function toHitBonus(ctx: Ctx, a: ActorInstance, atk: Attack): number {
  let b = statMod(getStat(ctx, a, atk.accuracyStat));
  const ps = playerOf(ctx, a);
  if (ps) b += Math.floor(ps.level / 2);
  return b;
}

/** a single weapon attack (caller checks range/LOS); fires on_hit; may kill */
export function performAttack(ctx: Ctx, attacker: ActorInstance, target: ActorInstance, info?: AttackInfo | null): AttackResult {
  const ai = info ?? attackOf(ctx, attacker);
  const res: AttackResult = { hit: false, crit: false, damage: 0, roll: 0 };
  if (!ai) return res;
  const atk = ai.attack;
  const roll = ctx.rng.int(1, 20);
  res.roll = roll;
  let bonus = toHitBonus(ctx, attacker, atk);
  // unaware targets are easier to hit
  if (!isPlayer(ctx, target) && !target.ai.alerted) bonus += 2;
  const ac = getStat(ctx, target, 'ac');
  const hit = isPlayer(ctx, attacker) ? roll > PLAYER_MISS_MAX : roll === 20 || (roll !== 1 && roll + bonus >= ac);
  res.hit = hit;
  res.crit = roll === 20;
  const aName = actorName(ctx, attacker);
  const tName = actorName(ctx, target);
  const ranged = atk.range > 1;
  provoke(ctx, attacker, target);
  if (!hit) {
    emit(ctx, { type: 'attacked', attackerId: attacker.id, targetId: target.id, hit: false, damage: 0, damageType: atk.damageType, ranged });
    // the built-in attack has no world-authored verb: its lines have their own keys, so the catalog
    // supplies the verb in the UI language ("angriper"), not the English "strikes"
    if (atk === DEFAULT_ACTOR_ATTACK) logKey(ctx, 'log.attack.miss_default', { attacker: aName, target: tName }, 'combat');
    else logKey(ctx, 'log.attack.miss', { attacker: aName, verb: atk.verb, target: tName }, 'combat');
    return res;
  }
  let dmg = evalAmount(ctx, atk.damage, attacker, res.crit);
  if (!ranged && atk.accuracyStat === 'str') dmg += Math.max(0, statMod(getStat(ctx, attacker, 'str')));
  dmg = Math.max(1, dmg);
  const dealt = dealDamage(ctx, target, dmg, atk.damageType, attacker.id, { quiet: true, deferKill: true });
  res.damage = dealt;
  emit(ctx, { type: 'attacked', attackerId: attacker.id, targetId: target.id, hit: true, damage: dealt, damageType: atk.damageType, ranged });
  const hitParams = { attacker: aName, verb: atk.verb, target: tName, amount: dealt };
  if (atk === DEFAULT_ACTOR_ATTACK) logKey(ctx, res.crit ? 'log.attack.crit_default' : 'log.attack.hit_default', { attacker: aName, target: tName, amount: dealt }, 'combat');
  else if (atk.damageType === 'physical') logKey(ctx, res.crit ? 'log.attack.crit' : 'log.attack.hit', hitParams, 'combat');
  else logKey(ctx, res.crit ? 'log.attack.crit_typed' : 'log.attack.hit_typed', { ...hitParams, damageType: damageTypeName(ctx, atk.damageType) }, 'combat');
  const aps = playerOf(ctx, attacker);
  if (aps && ai.slot !== null) withPlayer(ctx, aps.id, () => damageEquipped(ctx, ai.slot));
  if (isAlive(ctx, attacker)) fireTriggers(ctx, attacker, 'on_hit', { other: target, pos: target.pos });
  // the kill is announced after the hit line
  if (target.hp <= 0 && ctx.s.area.actors.includes(target)) finishKill(ctx, target, attacker.id);
  return res;
}

/** neutral/friendly actors attacked by the player side turn hostile */
export function provoke(ctx: Ctx, attacker: ActorInstance, target: ActorInstance): void {
  if (isPlayer(ctx, target)) return;
  if (side(ctx, attacker) !== 'P') return;
  if (target.allyOf) return;
  if (target.faction === 'neutral' || target.faction === 'friendly') {
    target.faction = 'hostile';
    logKey(ctx, 'log.provoke', { target: actorName(ctx, target) }, 'warning');
  }
  target.ai.alerted = true;
  target.ai.lastSeen = { ...attacker.pos };
}

export interface DamageOpts {
  /** skip resistances */
  raw?: boolean;
  /** don't log the generic damage line (attack logs its own) */
  quiet?: boolean;
  /** leave a killed target for the caller to finish (finishKill) */
  deferKill?: boolean;
}

/** applies damage after resistances; handles low-hp and death; returns damage dealt */
export function dealDamage(ctx: Ctx, target: ActorInstance, raw: number, damageType: string, sourceId?: string, opts: DamageOpts = {}): number {
  if (!isAlive(ctx, target) || raw <= 0 || ctx.s.status !== 'playing') return 0;
  let mult = 1;
  if (!opts.raw && !isPlayer(ctx, target)) {
    for (const r of actorDef(ctx, target)?.resistances ?? []) if (r.damageType === damageType) mult *= r.multiplier;
  }
  const src0 = findActor(ctx, sourceId);
  // difficulty: hostiles hit the player's side harder or softer (engine/difficulty.ts)
  if (src0 && src0 !== target && side(ctx, src0) === 'H' && side(ctx, target) === 'P') mult *= profileOf(ctx.s).hostileDamage;
  let dmg = raw * mult;
  dmg = mult <= 0 ? 0 : Math.max(1, Math.round(dmg));
  const tName = actorName(ctx, target);
  if (dmg <= 0) {
    if (!opts.quiet) logKey(ctx, 'log.damage.immune', { target: tName }, 'combat');
    return 0;
  }
  target.hp -= dmg;
  emit(ctx, sourceId ? { type: 'damaged', actorId: target.id, amount: dmg, damageType, sourceId } : { type: 'damaged', actorId: target.id, amount: dmg, damageType });
  const src = src0;
  const tps = playerOf(ctx, target);
  if (tps) {
    ctx.s.stats.damageTaken += dmg;
    const harm: NonNullable<PlayerState['lastHarm']> = src && src !== target ? { by: actorName(ctx, src), damageType, turn: ctx.s.turn } : { damageType, turn: ctx.s.turn };
    if (ctx.harmCause?.status) harm.status = ctx.harmCause.status;
    if (ctx.harmCause?.terrain) harm.terrain = ctx.harmCause.terrain;
    tps.lastHarm = harm;
    withPlayer(ctx, tps.id, () => damageEquipped(ctx, tps.equipped.armour));
  } else if (src && isPlayer(ctx, src)) {
    ctx.s.stats.damageDealt += dmg;
  }
  if (!opts.quiet) {
    const kind = isPlayer(ctx, target) ? 'bad' : 'combat';
    if (damageType === 'physical') logKey(ctx, 'log.damage.take', { target: tName, amount: dmg }, kind);
    else logKey(ctx, 'log.damage.take_typed', { target: tName, amount: dmg, damageType: damageTypeName(ctx, damageType) }, kind);
  }
  if (!isPlayer(ctx, target)) {
    if (src && side(ctx, src) === 'P') provoke(ctx, src, target);
    target.ai.alerted = true;
  }
  if (target.hp <= 0) {
    // performAttack finishes the kill itself so the hit line is logged first
    if (!opts.deferKill) finishKill(ctx, target, sourceId);
    return dmg;
  }
  fireTriggers(ctx, target, 'on_hurt', src ? { other: src, pos: src.pos } : { pos: target.pos });
  checkLowHp(ctx, target);
  return dmg;
}

export function checkLowHp(ctx: Ctx, a: ActorInstance): void {
  if (!isAlive(ctx, a)) return;
  const low = a.hp < maxHp(ctx, a) * LOW_HP_FRACTION;
  if (low && !a.ai.lowHp) {
    a.ai.lowHp = true;
    if (isPlayer(ctx, a)) {
      emit(ctx, { type: 'low_hp' });
      const lines = ctx.world.gm.fallback.lowHp;
      if (lines.length) log(ctx, ctx.rng.pick(lines), 'gm');
    }
    fireTriggers(ctx, a, 'on_low_hp', { pos: a.pos });
  } else if (!low && a.ai.lowHp) {
    a.ai.lowHp = false;
  }
}

export function heal(ctx: Ctx, a: ActorInstance, amount: number): number {
  if (!isAlive(ctx, a) || amount <= 0) return 0;
  const before = a.hp;
  a.hp = Math.min(maxHp(ctx, a), a.hp + Math.round(amount));
  const n = a.hp - before;
  if (n > 0) emit(ctx, { type: 'healed', actorId: a.id, amount: n });
  if (a.ai.lowHp && a.hp >= maxHp(ctx, a) * LOW_HP_FRACTION) a.ai.lowHp = false;
  return n;
}

// ---------------------------------------------------------------------------
// Death
// ---------------------------------------------------------------------------

/** removes a defeated actor (or ends the run for the player) */
export function killActor(ctx: Ctx, victim: ActorInstance, killerId: string | undefined): void {
  finishKill(ctx, victim, killerId);
}

export function finishKill(ctx: Ctx, victim: ActorInstance, killerId: string | undefined): void {
  if (!ctx.s.area.actors.includes(victim)) return;
  if (isPlayer(ctx, victim)) {
    killPlayer(ctx, victim, killerId);
    return;
  }
  const def = actorDef(ctx, victim);
  const killer = findActor(ctx, killerId);
  const vName = actorName(ctx, victim);
  ctx.s.area.actors = ctx.s.area.actors.filter((a) => a !== victim);
  victim.hp = Math.min(victim.hp, 0);
  emit(ctx, killerId ? { type: 'died', actorId: victim.id, defId: victim.defId, killerId } : { type: 'died', actorId: victim.id, defId: victim.defId });
  // a transformed actor (a unique's later phase) counts as defeating every form it has had
  const chain = defChain(victim);
  // an actor fighting on the player's side (a summoned or converted ally) does not count as
  // "defeated": otherwise a copy of the goal actor made friendly could be bumped to death for a win
  const wasAlly = side(ctx, victim) === 'P';
  if (!wasAlly) for (const id of chain) ctx.s.defeated[id] = (own(ctx.s.defeated, id) ?? 0) + 1;
  logKey(ctx, 'log.defeated', { target: vName, defeated: ctx.world.vocabulary.defeated }, 'combat');
  // on_death triggers run with the victim as the user (it is no longer listed); earlier unique
  // forms fire theirs too (oldest first), so a boss's "defeated" flags survive a second phase
  const tc = killer ? { other: killer, pos: victim.pos } : { pos: victim.pos };
  for (const id of chain.slice(0, -1)) {
    const former = ctx.ix.actors.get(id);
    if (former?.unique) fireDefTriggers(ctx, victim, id, 'on_death', tc);
  }
  fireTriggers(ctx, victim, 'on_death', tc);
  const byPlayerSide = !!killer && side(ctx, killer) === 'P';
  if (byPlayerSide && def) {
    ctx.s.stats.kills += 1;
    const vc = switchesOf(ctx).violenceCounter;
    if (vc) ctx.s.counters[vc] = (own(ctx.s.counters, vc) ?? 0) + 1;
    if (def.xp > 0) grantXp(ctx, def.xp);
  }
  if (killer && isAlive(ctx, killer)) fireTriggers(ctx, killer, 'on_kill', { other: victim, pos: victim.pos });
  if (def && !switchesOf(ctx).noLoot) {
    for (const l of def.loot) {
      if (ctx.rng.chance(l.chance) && ctx.ix.items.has(l.item)) dropItemAt(ctx, l.item, 1, victim.pos);
    }
  }
}

function killPlayer(ctx: Ctx, p: ActorInstance, killerId: string | undefined): void {
  const ps = playerOf(ctx, p)!;
  // a world's mercy rule, or Gentle's second chance: once per run and player
  if ((switchesOf(ctx).permadeathMercy || profileOf(ctx.s).secondChance) && !ps.mercyUsed) {
    ps.mercyUsed = true;
    p.hp = Math.max(1, Math.ceil(maxHp(ctx, p) / 2));
    p.ai.lowHp = false;
    logKey(ctx, 'log.mercy', { player: ps.name }, 'good');
    return;
  }
  p.hp = Math.min(p.hp, 0);
  if (ctx.s.status !== 'playing') return;
  const k = findActor(ctx, killerId);
  const killer = k && k !== p ? k : undefined;
  emit(ctx, killer ? { type: 'died', actorId: p.id, defId: p.defId, killerId: killer.id } : { type: 'died', actorId: p.id, defId: p.defId });
  const lr = lossReasonKeyed(ctx, killer, ps);
  endGame(ctx, 'lost', lr.text, lr);
}

/**
 * The loss line for a player who ran out of hp: the defeat word, who did it and with what, e.g.
 * "put in the dirt by Mesa Rattler (Lead)". Uses the killer when known, else the last harm the
 * player took (a status, a rule, terrain or an attacker that has since left).
 */
export function lossReason(ctx: Ctx, killer?: ActorInstance, ps: PlayerState = me(ctx)): string {
  return lossReasonKeyed(ctx, killer, ps).text;
}

/**
 * lossReason with its catalog key (END_REASON_KEYS) and params. The cause part names the status
 * or terrain that did it ("Parched, Heat"), else the damage kind when the world names it (an
 * unnamed built-in 'physical' says nothing).
 */
export function lossReasonKeyed(ctx: Ctx, killer?: ActorInstance, ps: PlayerState = me(ctx)): { text: string; key: EndReasonKey; params: LogParams } {
  const defeated = ctx.world.vocabulary.defeated;
  const h = ps.lastHarm;
  const by = killer ? actorName(ctx, killer) : h?.by;
  const typeName = h && ctx.ix.damageTypes.has(h.damageType) ? damageTypeName(ctx, h.damageType) : '';
  const source = h?.status ? statusName(ctx, h.status) : h?.terrain ? (ctx.ix.terrains.get(h.terrain)?.name ?? h.terrain) : '';
  const params: LogParams = { defeated };
  if (by) params.by = by;
  let key: EndReasonKey;
  if (source && typeName && typeName !== source) {
    key = by ? 'end.loss.by_cause_typed' : 'end.loss.cause_typed';
    params.cause = source;
    params.damageType = typeName;
  } else if (source || typeName) {
    key = by ? 'end.loss.by_cause' : 'end.loss.cause';
    params.cause = source || typeName;
  } else key = by ? 'end.loss.by' : 'end.loss.defeated';
  return { text: renderTemplate(END_REASON_KEYS[key], params), key, params };
}
