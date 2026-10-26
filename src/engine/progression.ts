/** XP, level-ups and perks. */
import type { Perk } from '../schema/world';
import { type Ctx, emit, logKey, me, playerActor, playerActorOf, withPlayer } from './ctx';
import { modifyStat } from './effects';
import { giveItem } from './inventory';

/** total xp needed to go from `level` to `level + 1` */
export function xpToNext(ctx: Ctx, level: number): number {
  const g = ctx.world.player.growth;
  return Math.max(1, Math.round(g.firstLevelXp * Math.pow(g.curve, Math.max(0, level - 1))));
}

/**
 * XP is shared in full: every player in the party gets the whole amount (kills, grant_xp effects
 * and GM grants alike), one log line; level-ups are checked per player in party order.
 */
export function grantXp(ctx: Ctx, amount: number): void {
  if (!(amount > 0) || !Number.isFinite(amount)) return;
  const n = Math.round(amount);
  for (const id of ctx.s.party) ctx.s.players[id].xp += n;
  logKey(ctx, 'log.xp', { amount: n, xp: ctx.world.vocabulary.xp }, 'good');
  for (const id of ctx.s.party) if (playerActorOf(ctx, id)) withPlayer(ctx, id, () => checkLevelUp(ctx));
}

export function availablePerks(ctx: Ctx, level: number): Perk[] {
  return ctx.world.player.growth.perks.filter((p) => p.minLevel <= level && !me(ctx).perks.includes(p.id));
}

/**
 * Most levels one call of checkLevelUp may grant (one big xp grant, or the levels unlocked by a
 * perk choice). Bounds the work of an absurd grant in a flat-curve world; xp left over past the
 * cap is dropped so the bar does not show millions of unspendable points.
 */
export const MAX_LEVELS_PER_CHECK = 50;

/**
 * Levels up while there is enough xp and no perk choice is pending (a pending choice stops it;
 * choosePerk resumes). Iterative, at most MAX_LEVELS_PER_CHECK levels per call.
 */
export function checkLevelUp(ctx: Ctx): void {
  const p = me(ctx);
  const g = ctx.world.player.growth;
  for (let gained = 0; !p.pendingPerkChoice; gained++) {
    const need = xpToNext(ctx, p.level);
    if (!(p.xp >= need)) return;
    if (gained >= MAX_LEVELS_PER_CHECK) {
      p.xp = Math.max(0, need - 1);
      return;
    }
    p.xp -= need;
    p.level += 1;
    const pa = playerActor(ctx);
    pa.maxHp += g.hpPerLevel;
    pa.hp += g.hpPerLevel;
    pa.maxMp += g.mpPerLevel;
    pa.mp += g.mpPerLevel;
    const pool = availablePerks(ctx, p.level).map((x) => x.id);
    ctx.rng.shuffle(pool);
    const choices = pool.slice(0, g.choices);
    p.pendingPerkChoice = choices.length ? choices : null;
    emit(ctx, { type: 'level_up', level: p.level, choices });
    logKey(ctx, 'log.levelup', { levelUp: ctx.world.vocabulary.levelUp, level: p.level }, 'good');
  }
}

export function applyPerk(ctx: Ctx, perk: Perk): void {
  const pa = playerActor(ctx);
  me(ctx).perks.push(perk.id);
  for (const m of perk.modifiers) modifyStat(ctx, pa, m.stat, m.amount);
  for (const item of perk.grantItems) giveItem(ctx, item, 1);
  logKey(ctx, 'log.perk', { perk: perk.name, description: perk.description }, 'good');
}

/** resolves a pending perk choice; returns an error reason or null */
export function choosePerk(ctx: Ctx, perkId: string): string | null {
  const p = me(ctx);
  if (!p.pendingPerkChoice) return 'no perk choice pending';
  if (!p.pendingPerkChoice.includes(perkId)) return 'that perk is not on offer';
  const perk = ctx.ix.perks.get(perkId);
  if (!perk) return 'unknown perk';
  p.pendingPerkChoice = null;
  applyPerk(ctx, perk);
  checkLevelUp(ctx);
  return null;
}
