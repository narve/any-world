/** XP, level-ups and perks. */
import type { Perk } from '../schema/world';
import { type Ctx, emit, logKey, playerActor } from './ctx';
import { modifyStat } from './effects';
import { giveItem } from './inventory';

/** total xp needed to go from `level` to `level + 1` */
export function xpToNext(ctx: Ctx, level: number): number {
  const g = ctx.world.player.growth;
  return Math.max(1, Math.round(g.firstLevelXp * Math.pow(g.curve, Math.max(0, level - 1))));
}

export function grantXp(ctx: Ctx, amount: number): void {
  if (!(amount > 0) || !Number.isFinite(amount)) return;
  ctx.s.player.xp += Math.round(amount);
  logKey(ctx, 'log.xp', { amount: Math.round(amount), xp: ctx.world.vocabulary.xp }, 'good');
  checkLevelUp(ctx);
}

export function availablePerks(ctx: Ctx, level: number): Perk[] {
  return ctx.world.player.growth.perks.filter((p) => p.minLevel <= level && !ctx.s.player.perks.includes(p.id));
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
  const p = ctx.s.player;
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
  ctx.s.player.perks.push(perk.id);
  for (const m of perk.modifiers) modifyStat(ctx, pa, m.stat, m.amount);
  for (const item of perk.grantItems) giveItem(ctx, item, 1);
  logKey(ctx, 'log.perk', { perk: perk.name, description: perk.description }, 'good');
}

/** resolves a pending perk choice; returns an error reason or null */
export function choosePerk(ctx: Ctx, perkId: string): string | null {
  const p = ctx.s.player;
  if (!p.pendingPerkChoice) return 'no perk choice pending';
  if (!p.pendingPerkChoice.includes(perkId)) return 'that perk is not on offer';
  const perk = ctx.ix.perks.get(perkId);
  if (!perk) return 'unknown perk';
  p.pendingPerkChoice = null;
  applyPerk(ctx, perk);
  checkLevelUp(ctx);
  return null;
}
