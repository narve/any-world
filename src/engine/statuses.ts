/** Status application, removal and per-round ticking. Flags are interpreted by ai/actions/stats. */
import type { ActorInstance } from './types';
import { type Ctx, actorName, emit, isAlive, isPlayer, log, statusName } from './ctx';
import { applyEffectList } from './effects';
import { heal } from './combat';
import { findActor } from './ctx';

export function applyStatus(ctx: Ctx, a: ActorInstance, statusId: string, duration: number, sourceId?: string): boolean {
  const def = ctx.ix.statuses.get(statusId);
  if (!def) return false;
  const turns = Math.max(1, Math.floor(duration));
  const existing = a.statuses.find((s) => s.id === statusId);
  if (existing) {
    existing.turnsLeft = Math.max(existing.turnsLeft, turns);
    if (sourceId) existing.sourceId = sourceId;
  } else {
    a.statuses.push(sourceId ? { id: statusId, turnsLeft: turns, sourceId } : { id: statusId, turnsLeft: turns });
    emit(ctx, { type: 'status_applied', actorId: a.id, status: statusId });
    if (isPlayer(ctx, a)) log(ctx, `${actorName(ctx, a)}: ${def.name}.`, def.harmful ? 'bad' : 'good');
  }
  return true;
}

/** returns the ids removed */
export function removeStatus(ctx: Ctx, a: ActorInstance, which: string): string[] {
  const removed: string[] = [];
  a.statuses = a.statuses.filter((s) => {
    const def = ctx.ix.statuses.get(s.id);
    const match = which === 'all_harmful' ? !!def?.harmful : s.id === which;
    if (match) removed.push(s.id);
    return !match;
  });
  for (const id of removed) {
    emit(ctx, { type: 'status_expired', actorId: a.id, status: id });
    if (isPlayer(ctx, a)) log(ctx, `${statusName(ctx, id)} ends.`, 'info');
  }
  return removed;
}

/** per-turn effects (and the regenerating flag) of all statuses on `a` */
export function statusPerTurn(ctx: Ctx, a: ActorInstance): void {
  for (const st of [...a.statuses]) {
    if (!isAlive(ctx, a)) return;
    const def = ctx.ix.statuses.get(st.id);
    if (!def) continue;
    if (def.perTurn.length) {
      const src = findActor(ctx, st.sourceId);
      const user = src && isAlive(ctx, src) ? src : a;
      applyEffectList(ctx, def.perTurn, user, [a], a.pos, [], st.sourceId);
    }
    if (def.flags.includes('regenerating') && isAlive(ctx, a) && !def.perTurn.some((e) => e.type === 'heal')) heal(ctx, a, 1);
  }
}

/** decrement durations; returns the ids that expired this round */
export function tickStatuses(ctx: Ctx, a: ActorInstance): Set<string> {
  const expired = new Set<string>();
  for (const s of a.statuses) s.turnsLeft -= 1;
  const keep = a.statuses.filter((s) => {
    if (s.turnsLeft > 0) return true;
    expired.add(s.id);
    return false;
  });
  a.statuses = keep;
  for (const id of expired) {
    emit(ctx, { type: 'status_expired', actorId: a.id, status: id });
    if (isPlayer(ctx, a)) log(ctx, `${statusName(ctx, id)} ends.`, 'info');
  }
  return expired;
}
