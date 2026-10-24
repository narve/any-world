/**
 * Active rules as the player sees them (DESIGN §4.3 "Visibility"): the world's starting rules plus
 * the ones the GM adds or retires during play. The engine keeps the live list in
 * `state.activeRules` (M2); older engine states have none, so the world's rules are used. Each rule
 * gets a "since" (area + turn) and, for GM rules, the in-story reason. A small tracker diffs the
 * list after every change so the UI can announce new rules and mark them for a while. Pure.
 */
import type { RuleVariant, WorldSpec } from '../schema/world';
import type { GameState } from '../engine/types';

export interface ActiveRule {
  rule: RuleVariant;
  source: 'world' | 'gm';
  /** area index / turn the rule came into force (absent = from the start) */
  sinceArea?: number;
  sinceTurn?: number;
  /** GM announcement */
  reason?: string;
}

/** loose shapes the engine may use for an activeRules entry */
type EntryLike = Partial<RuleVariant> & {
  rule?: RuleVariant;
  source?: string;
  origin?: string;
  fromGm?: boolean;
  since?: { area?: number; turn?: number } | number;
  sinceArea?: number;
  sinceTurn?: number;
  addedArea?: number;
  addedTurn?: number;
  area?: number;
  turn?: number;
  reason?: string;
};

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** normalises one engine entry (a RuleVariant, or a wrapper around one) */
function normalise(world: WorldSpec, e: EntryLike): ActiveRule | null {
  const rule = (e.rule && typeof e.rule === 'object' ? e.rule : e) as RuleVariant;
  if (!rule || typeof rule.id !== 'string' || typeof rule.name !== 'string') return null;
  const worldRule = world.rules.some((r) => r.id === rule.id);
  const src = e.source ?? e.origin;
  const source: ActiveRule['source'] = src === 'gm' || e.fromGm === true ? 'gm' : src === 'world' ? 'world' : worldRule ? 'world' : 'gm';
  const since = typeof e.since === 'object' && e.since ? e.since : undefined;
  const sinceTurn = num(since?.turn) ?? (typeof e.since === 'number' ? e.since : undefined) ?? num(e.sinceTurn) ?? num(e.addedTurn) ?? num(e.turn);
  const sinceArea = num(since?.area) ?? num(e.sinceArea) ?? num(e.addedArea) ?? num(e.area);
  const out: ActiveRule = { rule: { ...rule, description: rule.description ?? '' }, source };
  if (sinceTurn !== undefined && !(source === 'world' && sinceTurn === 0)) out.sinceTurn = sinceTurn;
  if (sinceArea !== undefined && out.sinceTurn !== undefined) out.sinceArea = sinceArea;
  if (typeof e.reason === 'string' && e.reason.trim()) out.reason = e.reason.trim();
  return out;
}

/** the rules in force right now */
export function activeRulesOf(world: WorldSpec, state: GameState): ActiveRule[] {
  const live = (state as GameState & { activeRules?: unknown }).activeRules;
  if (Array.isArray(live)) {
    const out: ActiveRule[] = [];
    const ids = new Set<string>();
    for (const e of live) {
      if (!e || typeof e !== 'object') continue;
      const r = normalise(world, e as EntryLike);
      if (r && !ids.has(r.rule.id)) {
        ids.add(r.rule.id);
        out.push(r);
      }
    }
    return out;
  }
  return world.rules.map((rule) => ({ rule, source: 'world' as const }));
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/** what the client remembers about each rule it has seen (persisted with the run) */
export interface RuleMemo {
  id: string;
  name: string;
  source: 'world' | 'gm';
  sinceArea?: number;
  sinceTurn?: number;
  reason?: string;
  /** turn until which the UI highlights the rule as new */
  newUntil?: number;
}

export interface RuleChange {
  kind: 'added' | 'removed';
  id: string;
  name: string;
  description: string;
  source: 'world' | 'gm';
  reason?: string;
}

/** turns a new rule stays highlighted */
export const NEW_RULE_TURNS = 12;

export class RuleTracker {
  private memo = new Map<string, RuleMemo>();
  private current = new Set<string>();

  constructor(saved?: RuleMemo[]) {
    for (const m of saved ?? []) this.memo.set(m.id, { ...m });
  }

  /** prime with the run's starting rules (no announcements) */
  prime(world: WorldSpec, state: GameState): void {
    for (const r of activeRulesOf(world, state)) {
      this.current.add(r.rule.id);
      if (!this.memo.has(r.rule.id)) this.memo.set(r.rule.id, this.memoOf(r));
    }
  }

  private memoOf(r: ActiveRule, state?: GameState): RuleMemo {
    const m: RuleMemo = { id: r.rule.id, name: r.rule.name, source: r.source };
    const turn = r.sinceTurn ?? (state && r.source === 'gm' ? state.turn : undefined);
    const area = r.sinceArea ?? (turn !== undefined ? state?.area.index : undefined);
    if (turn !== undefined) m.sinceTurn = turn;
    if (area !== undefined) m.sinceArea = area;
    if (r.reason) m.reason = r.reason;
    return m;
  }

  /** compare with the state after a change; returns what was added/removed */
  update(world: WorldSpec, state: GameState): RuleChange[] {
    const rules = activeRulesOf(world, state);
    const ids = new Set(rules.map((r) => r.rule.id));
    const changes: RuleChange[] = [];
    for (const r of rules) {
      if (this.current.has(r.rule.id)) continue;
      const m = this.memoOf(r, state);
      if (m.sinceTurn === undefined) {
        m.sinceTurn = state.turn;
        m.sinceArea = state.area.index;
      }
      m.newUntil = state.turn + NEW_RULE_TURNS;
      this.memo.set(r.rule.id, m);
      changes.push({ kind: 'added', id: r.rule.id, name: r.rule.name, description: r.rule.description, source: r.source, ...(r.reason ? { reason: r.reason } : {}) });
    }
    for (const id of this.current) {
      if (ids.has(id)) continue;
      const m = this.memo.get(id);
      const def = world.rules.find((r) => r.id === id);
      changes.push({ kind: 'removed', id, name: m?.name ?? def?.name ?? id, description: def?.description ?? '', source: m?.source ?? 'world' });
      this.memo.delete(id);
    }
    this.current = ids;
    return changes;
  }

  memoFor(id: string): RuleMemo | undefined {
    return this.memo.get(id);
  }

  /** mark everything as seen (rules panel opened) */
  acknowledge(): void {
    for (const m of this.memo.values()) delete m.newUntil;
  }

  toJSON(): RuleMemo[] {
    return [...this.memo.values()].map((m) => ({ ...m }));
  }
}
