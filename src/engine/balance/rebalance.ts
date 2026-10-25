/**
 * autoRebalance: bounded, schema-respecting adjustments that move a world toward its difficulty
 * band, then re-validation with parseWorld. It never invents content: it scales numbers, re-weights
 * spawn tables with items the world already has, and places existing items/actors that a goal or a
 * transition lock needs but that never appear.
 *
 *   too_hard   → hostile hp/damage ×0.7–0.9 (bosses with npc dialogue included), healing items more common (+1 item per area),
 *                harmful rules softened (rule damage halved, on_turn rules fire less often,
 *                resource drains −25%), the top killer weakened a bit more
 *   too_easy   → hostile hp/damage ×1.15–1.6 (more the further above the band), healing less common
 *   unwinnable → missing goal/lock items and actors placed where they are needed
 *   broken/ok  → only the unwinnable fixes (soft-locks and crashes need a human or an engine fix)
 */
import type { ActorDef, Amount, Condition, Effect, ItemDef, WorldSpec } from '../../schema/world';
import { parseWorld } from '../../schema/refs';
import { avgAmount, itemProfile } from '../sim/view';
import { collectSources, type Sources } from './static';
import { estimateRuleImpact } from './rules';
import type { BalanceReport, VerdictResult } from './analyse';

export interface RebalanceResult {
  world: WorldSpec;
  changes: string[];
  /** false when the adjusted world failed validation (the original is returned) */
  valid: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** mean of an NdM roll, 0 for no dice */
function diceMean(dice: string | undefined): number {
  const m = dice ? /^(\d{1,2})d(\d{1,3})$/.exec(dice) : null;
  return m ? (Number(m[1]) * (Number(m[2]) + 1)) / 2 : 0;
}

/**
 * Scales an amount's expected value (base + dice mean) by `f` and re-splits it, so nothing ever
 * collapses (issues/M2-sim-tune-cannot-fix-too-easy.md): the dice keep their count and get
 * round(sides × f) sides (at least 2), and the base absorbs the rounding of the dice, so the new
 * mean stays as close to the scaled mean as whole numbers allow. A non-zero base keeps its sign and
 * a magnitude of at least 1 — {base: 1, dice: '1d4'} × 0.35 used to become {base: 0, dice: '1d2'}
 * and `base` never came back on later upscales — and a zero base only becomes positive. The stat
 * scale factor is scaled as is.
 */
export function scaleAmount(a: Amount, f: number): Amount {
  const out: Amount = { ...a };
  const base = a.base ?? 0;
  const target = (base + diceMean(a.dice)) * f;
  const hasBase = base !== 0 || a.base !== undefined;
  const fitBase = (dm: number) => {
    const b = Math.round(target - dm);
    return base > 0 ? Math.max(1, b) : base < 0 ? Math.min(-1, b) : Math.max(0, b);
  };
  const m = out.dice ? /^(\d{1,2})d(\d{1,3})$/.exec(out.dice) : null;
  if (m) {
    const n = Number(m[1]);
    const ideal = clamp(Math.round(Number(m[2]) * f), 2, 999);
    // the base's floor can overshoot the target (1 + 3d3 for 6); then a die a side or two off
    // the proportional size may fit better — the closest mean wins, then the proportional die
    let best = { sides: ideal, err: Infinity };
    for (let d = 0; d <= 2; d++)
      for (const sides of d ? [ideal - d, ideal + d] : [ideal]) {
        if (sides < 2 || sides > 999) continue;
        const dm = (n * (sides + 1)) / 2;
        const err = Math.abs((hasBase ? fitBase(dm) : 0) + dm - target);
        if (err < best.err - 1e-9) best = { sides, err };
      }
    out.dice = `${n}d${best.sides}`;
  }
  if (hasBase) out.base = fitBase(diceMean(out.dice));
  if (out.scale) out.scale = { ...out.scale, factor: Math.round(out.scale.factor * f * 100) / 100 };
  return out;
}

/**
 * Scales a positive stat by `f`, moving it by at least 1 when f ≠ 1 (hp 1 × 1.3 used to stay 1
 * forever), within [lo, hi].
 */
function scaleStat(v: number, f: number, lo: number, hi: number): number {
  let n = Math.round(v * f);
  if (f > 1 && n <= v) n = v + 1;
  if (f < 1 && n >= v) n = v - 1;
  return clamp(n, lo, hi);
}

function scaleDamageEffects(effects: Effect[], f: number): Effect[] {
  return effects.map((e) => (e.type === 'damage' ? { ...e, amount: scaleAmount(e.amount, f) } : e));
}

/**
 * Scales every hostile actor's hp and damage — including hostiles with npc dialogue (bosses you
 * can also talk to are often the deadliest actors in a world). Their persuade DC is left alone, so
 * talking one down stays exactly as hard as written. Non-hostile actors are never touched.
 */
function scaleHostiles(w: WorldSpec, f: number, changes: string[], only?: Set<string>): void {
  let n = 0;
  for (const a of w.actors) {
    if (a.faction !== 'hostile') continue;
    if (only && !only.has(a.id)) continue;
    a.stats.hp = scaleStat(a.stats.hp, f, 1, 500);
    if (a.attack) a.attack = { ...a.attack, damage: scaleAmount(a.attack.damage, f) };
    a.abilities = a.abilities.map((ab) => {
      const t = ab.action.targeting.affects;
      if (t === 'allies' || t === 'self_only') return ab;
      return { ...ab, action: { ...ab.action, effects: scaleDamageEffects(ab.action.effects, f) } };
    });
    n++;
  }
  if (n) changes.push(`${only ? [...only].join(', ') : `${n} hostile actors`}: hp and damage ×${f}`);
}

/** the world's most useful plain healing consumable (for spawn tables) */
export function bestHealingItem(w: WorldSpec): ItemDef | null {
  let best: ItemDef | null = null;
  let score = 0;
  for (const it of w.items) {
    const pr = itemProfile(w, it);
    if (pr.heal <= 0 || pr.selfHarm || pr.offensive || it.useMode === 'passive' || it.rarity === 'unique') continue;
    // prefer commonly known, consumed heals of moderate size
    const s = pr.heal * (it.useMode === 'consumed' ? 1 : 0.6) * (it.knowledge === 'unknown' ? 0.6 : 1) * (it.rarity === 'common' ? 1.2 : 1);
    if (s > score) {
      score = s;
      best = it;
    }
  }
  return best;
}

function addHealing(w: WorldSpec, changes: string[], extraItems: number): void {
  const heal = bestHealingItem(w);
  if (!heal) {
    changes.push('no healing item to add (the world has none)');
    return;
  }
  for (const [i, plan] of w.areas.entries()) {
    const e = plan.items.find((x) => x.item === heal.id);
    if (e) e.weight = clamp(Math.round(e.weight * 1.5 + 5), 0, 100);
    else if (plan.items.length < 16) plan.items.push({ item: heal.id, weight: 15 });
    plan.itemCount = clamp(plan.itemCount + extraItems, 0, 30);
    void i;
  }
  changes.push(`"${heal.id}" more common in every area${extraItems ? `, +${extraItems} item per area` : ''}`);
}

function cutHealing(w: WorldSpec, changes: string[]): void {
  let n = 0;
  for (const plan of w.areas)
    for (const e of plan.items) {
      // an entry the author disabled (weight 0) stays disabled; enabled ones stay enabled (≥ 1)
      if (e.weight <= 0) continue;
      const d = w.items.find((x) => x.id === e.item);
      if (d && itemProfile(w, d).heal > 0) {
        const next = Math.max(1, Math.round(e.weight * 0.6));
        if (next === e.weight) continue;
        e.weight = next;
        n++;
      }
    }
  if (n) changes.push(`healing items 40% less common (${n} spawn entries)`);
}

/**
 * Shrinks a harmful amount by `f` without ever removing it: a base keeps its sign and at least
 * magnitude 1 (Math.round(-1 * 0.5) is -0, which deleted -1 drains), dice keep at least 2 sides.
 * Returns an equal amount when it cannot get smaller.
 */
export function softenAmount(a: Amount, f: number): Amount {
  const out: Amount = { ...a };
  if (out.base) out.base = Math.sign(out.base) * Math.max(1, Math.round(Math.abs(out.base) * f));
  if (out.dice) {
    const m = /^(\d{1,2})d(\d{1,3})$/.exec(out.dice);
    if (m) out.dice = `${Number(m[1])}d${clamp(Math.round(Number(m[2]) * f), 2, 999)}`;
  }
  if (out.scale) out.scale = { ...out.scale, factor: Math.round(out.scale.factor * f * 100) / 100 };
  return out;
}

function isDrain(e: Effect): e is Extract<Effect, { type: 'damage' | 'resource' }> {
  return e.type === 'damage' || (e.type === 'resource' && (e.amount.base ?? 0) < 0);
}

function softenRules(w: WorldSpec, changes: string[]): void {
  for (const r of w.rules) {
    const imp = estimateRuleImpact(w, r);
    if (!imp.harmful || imp.magnitude === 'none') continue;
    let cutAny = false;
    let slowerAny = false;
    r.playerTriggers = r.playerTriggers.map((tr) => {
      if (!tr.action.effects.some(isDrain)) return tr;
      let cut = false;
      const effects = tr.action.effects.map((e) => {
        if (!isDrain(e)) return e;
        const amount = softenAmount(e.amount, 0.5);
        if (JSON.stringify(amount) === JSON.stringify(e.amount)) return e;
        cut = true;
        return { ...e, amount };
      });
      // on_turn triggers fire less often; when the amounts are already at their minimum (a -1
      // drain), twice as rarely instead, so the rule is still softened
      let every = tr.every;
      if (tr.on === 'on_turn') {
        const cur = tr.every ?? 1;
        const next = clamp(Math.ceil(cur * (cut ? 1.5 : 2)), 1, 100);
        if (next !== cur) {
          every = next;
          slowerAny = true;
        }
      }
      if (cut) cutAny = true;
      return { ...tr, ...(every !== undefined ? { every } : {}), action: { ...tr.action, effects } };
    });
    // only report what actually changed
    const what = [cutAny ? 'harmful trigger effects halved' : '', slowerAny ? 'on_turn slower' : ''].filter(Boolean).join(', ');
    if (what) changes.push(`rule "${r.id}" softened (${what})`);
  }
  for (const res of w.resources) {
    if (res.perTurn < 0) {
      res.perTurn = Math.round(res.perTurn * 0.75 * 100) / 100;
      changes.push(`resource "${res.id}" drains slower (${res.perTurn}/turn)`);
    }
  }
}

/**
 * The hostile actor behind the most deaths. Death causes read "killed by <label>", where the label
 * starts with the actor's name but may carry more (a title, the damage type…), so causes are
 * matched to the hostile with the longest name they start with and tallied per actor.
 */
export function topKiller(w: WorldSpec, deathsByCause: Record<string, number>): ActorDef | undefined {
  const hostiles = w.actors.filter((a) => a.faction === 'hostile').sort((a, b) => b.name.length - a.name.length);
  const tally = new Map<string, number>();
  for (const [cause, n] of Object.entries(deathsByCause)) {
    const label = cause.replace(/^killed by /, '');
    const a = hostiles.find((h) => label === h.name || label.startsWith(h.name));
    if (a) tally.set(a.id, (tally.get(a.id) ?? 0) + n);
  }
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? w.actors.find((a) => a.id === top[0]) : undefined;
}

// --- feasibility fixes -------------------------------------------------------

type Missing = { kind: 'item' | 'actor'; id: string };

function missing(w: WorldSpec, src: Sources, c: Condition | undefined, limit: number, depth = 0): Missing[] {
  if (!c || depth > 16) return [];
  switch (c.type) {
    case 'all':
      return c.of.flatMap((x) => missing(w, src, x, limit, depth + 1));
    case 'any': {
      const branches = c.of.map((x) => missing(w, src, x, limit, depth + 1));
      if (branches.some((b) => b.length === 0)) return [];
      return branches.sort((a, b) => a.length - b.length)[0] ?? [];
    }
    case 'has_item': {
      const at = src.items.get(c.item);
      return at === undefined || at > limit ? [{ kind: 'item', id: c.item }] : [];
    }
    case 'actor_defeated': {
      const at = src.actors.get(c.actor);
      return at === undefined || at > limit ? [{ kind: 'actor', id: c.actor }] : [];
    }
    default:
      return [];
  }
}

function fixFeasibility(w: WorldSpec, changes: string[]): void {
  const last = w.areas.length - 1;
  const place = (m: Missing, area: number) => {
    const plan = w.areas[area];
    if (m.kind === 'item') {
      if (!w.items.some((x) => x.id === m.id)) return;
      if (plan.placedItems.length >= 6) return changes.push(`could not place "${m.id}" in area ${area + 1} (placedItems full)`);
      plan.placedItems.push({ item: m.id, where: area === last ? 'guarded' : 'anywhere' });
      changes.push(`placed missing item "${m.id}" in area ${area + 1}`);
    } else {
      if (!w.actors.some((x) => x.id === m.id)) return;
      if (plan.placed.length >= 6) return changes.push(`could not place "${m.id}" in area ${area + 1} (placed full)`);
      plan.placed.push({ actor: m.id, where: area === last ? 'near_exit' : 'far' });
      changes.push(`placed missing actor "${m.id}" in area ${area + 1}`);
    }
  };
  for (let i = 0; i < last; i++) {
    const src = collectSources(w);
    for (const m of missing(w, src, w.areas[i].transitionRequires, i)) place(m, i);
  }
  const src = collectSources(w);
  for (const m of missing(w, src, w.goal.win, last)) place(m, last);
}

// ---------------------------------------------------------------------------

/** hostile scale factor for a too_easy world: 1 + 1.5 × (winRate − band top), within 1.15–1.6 */
export function tooEasyFactor(winRate: number, hi: number): number {
  return Math.round(clamp(1 + 1.5 * (winRate - hi), 1.15, 1.6) * 100) / 100;
}

export function rebalance(world: WorldSpec, report: Pick<BalanceReport, 'verdict' | 'winRate' | 'target' | 'sims'> | VerdictResult): RebalanceResult {
  const w = structuredClone(world) as WorldSpec;
  const changes: string[] = [];
  fixFeasibility(w, changes);
  const [lo, hi] = report.target;
  if (report.verdict === 'too_hard') {
    const f = report.winRate <= 0 ? 0.7 : report.winRate < lo / 2 ? 0.8 : 0.9;
    scaleHostiles(w, f, changes);
    addHealing(w, changes, report.winRate < lo / 2 ? 1 : 0);
    softenRules(w, changes);
    // the top killer of the explorer takes an extra cut
    const sims = 'sims' in report ? report.sims : [];
    const basis = sims.find((s) => s.bot === 'explorer') ?? sims[0];
    const def = basis ? topKiller(w, basis.deathsByCause) : undefined;
    if (def) scaleHostiles(w, 0.85, changes, new Set([def.id]));
  } else if (report.verdict === 'too_easy') {
    // the further above the band, the harder the push: ×1.15 just above it, up to ×1.6 (a world
    // the bots win 90%+ of the time under a normal band needs ~×1.6, and ×1.3 per round could not
    // undo a ×0.35 world in three rounds)
    const f = tooEasyFactor(report.winRate, hi);
    scaleHostiles(w, f, changes);
    cutHealing(w, changes);
  }
  if (!changes.length) return { world, changes: ['no changes'], valid: true };
  const parsed = parseWorld(JSON.parse(JSON.stringify(w)));
  if (!parsed.ok) return { world, changes: [...changes, `rejected: adjusted world failed validation (${parsed.errors.slice(0, 3).join('; ')})`], valid: false };
  return { world: parsed.world, changes, valid: true };
}

/**
 * Only the feasibility fixes (place missing goal / lock items and actors), re-validated. Returns
 * the input world itself when nothing was missing.
 */
export function feasibilityFixes(world: WorldSpec): RebalanceResult {
  const w = structuredClone(world) as WorldSpec;
  const changes: string[] = [];
  fixFeasibility(w, changes);
  if (!changes.length) return { world, changes: ['no changes'], valid: true };
  const parsed = parseWorld(JSON.parse(JSON.stringify(w)));
  if (!parsed.ok) return { world, changes: [...changes, `rejected: adjusted world failed validation (${parsed.errors.slice(0, 3).join('; ')})`], valid: false };
  return { world: parsed.world, changes, valid: true };
}

/** the adjusted world (re-validated); see rebalance() for the change list */
export function autoRebalance(world: WorldSpec, report: Pick<BalanceReport, 'verdict' | 'winRate' | 'target' | 'sims'> | VerdictResult): WorldSpec {
  return rebalance(world, report).world;
}

// --- new-player fixes ----------------------------------------------------------
// issues/M5-new-player-deaths.md: new players died in the first area and to small heals. These
// fixes are about the first minutes of a run, not the world's overall band, so they apply to any
// verdict (tuneWorld runs them once, before its loop; the demo worlds were retuned with them).

/** hostiles the first area's spawn table may produce at most, per area size */
export const FIRST_AREA_MAX_HOSTILES: Record<string, number> = { small: 3, medium: 4, large: 5 };
/** hostiles the first area's spawn table guarantees at most (the sum of the entries' minimums) */
export const FIRST_AREA_MAX_GUARANTEED = 2;
/** a healing consumable heals at least this share of the player's starting max hp */
export const MIN_HEAL_SHARE = 0.25;
/** healing below this share of max hp is a side effect (a coffee that heals 2), not a heal item */
const HEAL_ITEM_SHARE = 0.1;

/** how far an action's damage reaches (0: none, or only the adjacent tiles and the user) */
function damageReach(a: { targeting: { shape: string; range: number; radius: number; affects: string }; effects: Effect[] } | undefined): number {
  if (!a || !a.effects.some((e) => e.type === 'damage')) return 0;
  const t = a.targeting;
  if (t.affects === 'allies' || t.affects === 'self_only' || t.shape === 'self') return 0;
  if (t.shape === 'adjacent') return 1;
  if (t.shape === 'all_visible') return 8;
  // a cone's length is its radius; an area reaches its centre's range plus its radius
  if (t.shape === 'cone') return Math.max(1, t.radius);
  if (t.shape === 'area') return t.range + t.radius;
  return t.range;
}

/** the farthest a hostile hurts from (1 = melee only) */
export function hostileReach(a: ActorDef): number {
  let r = a.attack?.range ?? 1;
  for (const ab of a.abilities) r = Math.max(r, damageReach(ab.action));
  return r;
}

function itemReach(it: ItemDef | undefined): number {
  if (!it) return 0;
  const weapon = it.weapon?.range ?? 0;
  return Math.max(weapon, it.useMode !== 'passive' ? damageReach(it.onUse) : 0);
}

/**
 * How far the player can hurt hostiles from in the first area: unarmed reach, starting items and
 * items placed in the first area (1 = melee only).
 */
export function playerReach(w: WorldSpec): number {
  const items = new Map(w.items.map((i) => [i.id, i]));
  let r = Math.max(1, w.player.unarmed.range);
  for (const s of w.player.startingItems) r = Math.max(r, itemReach(items.get(s.item)));
  for (const p of w.areas[0]?.placedItems ?? []) r = Math.max(r, itemReach(items.get(p.item)));
  return r;
}

/** ids an objective needs defeated (goal or a transition lock): never removed from a spawn table */
function neededActors(w: WorldSpec): Set<string> {
  const out = new Set<string>();
  const walk = (c: Condition | undefined, depth = 0): void => {
    if (!c || depth > 32) return;
    if (c.type === 'actor_defeated') out.add(c.actor);
    if (c.type === 'all' || c.type === 'any') for (const x of c.of) walk(x, depth + 1);
    if (c.type === 'not') walk(c.cond, depth + 1);
  };
  walk(w.goal.win);
  for (const a of w.areas) walk(a.transitionRequires);
  return out;
}

/** how dangerous one hostile is to fight: hp × mean hit (the hits are what kill a new player) */
export function hostileThreat(a: ActorDef): number {
  let hit = a.attack ? avgAmount(a.attack.damage) : 1;
  for (const ab of a.abilities) for (const e of ab.action.effects) if (e.type === 'damage') hit = Math.max(hit, avgAmount(e.amount));
  return a.stats.hp * Math.max(1, hit);
}

/**
 * Lowers `vals` one at a time until their sum is at most `cap`, always where count × weight[i] is
 * largest (the first index wins ties): the most dangerous share of the table goes first, the
 * fodder stays.
 */
function capSum(vals: number[], cap: number, weight: number[]): number[] {
  const out = [...vals];
  let sum = out.reduce((n, v) => n + v, 0);
  while (sum > cap) {
    let k = -1;
    for (let i = 0; i < out.length; i++) if (out[i] > 0 && (k < 0 || out[i] * weight[i] > out[k] * weight[k])) k = i;
    if (k < 0) break;
    out[k]--;
    sum--;
  }
  return out;
}

function firstAreaFixes(w: WorldSpec, changes: string[]): void {
  const plan = w.areas[0];
  if (!plan) return;
  const defs = new Map(w.actors.map((a) => [a.id, a]));
  const needed = neededActors(w);
  const hostile = plan.actors.filter((e) => defs.get(e.actor)?.faction === 'hostile');
  if (!hostile.length) return;
  // no shooters in the first area that outrange everything the player has (a melee-only courier
  // cannot catch a range-3 kiter)
  const reach = playerReach(w);
  {
    const out: string[] = [];
    for (const e of hostile) {
      const def = defs.get(e.actor)!;
      const r = hostileReach(def);
      if (r <= 1 || r <= reach || needed.has(def.id) || (e.max === 0 && e.min === 0)) continue;
      e.min = 0;
      e.max = 0;
      out.push(def.id);
    }
    if (out.length) changes.push(`area 1: no hostiles that outrange the player (reach ${reach}): ${out.join(', ')} removed from its spawn table`);
  }
  // a few hostiles at most, and only a couple guaranteed
  const cap = FIRST_AREA_MAX_HOSTILES[plan.size] ?? 4;
  const before = hostile.reduce((n, e) => n + Math.max(e.min, e.max), 0);
  const threat = hostile.map((e) => hostileThreat(defs.get(e.actor)!));
  const maxes = capSum(hostile.map((e) => Math.max(e.min, e.max)), cap, threat);
  hostile.forEach((e, i) => {
    e.max = maxes[i];
    e.min = Math.min(e.min, e.max);
  });
  const minBefore = hostile.reduce((n, e) => n + e.min, 0);
  const mins = capSum(hostile.map((e) => e.min), FIRST_AREA_MAX_GUARANTEED, threat);
  hostile.forEach((e, i) => (e.min = mins[i]));
  const after = hostile.reduce((n, e) => n + Math.max(e.min, e.max), 0);
  if (after < before || minBefore > FIRST_AREA_MAX_GUARANTEED) changes.push(`area 1: spawn table capped at ${after} hostiles (was ${before}), at most ${FIRST_AREA_MAX_GUARANTEED} guaranteed`);
}

function scaleHeals(w: WorldSpec, changes: string[]): void {
  const hp = w.player.stats.hp;
  const want = hp * MIN_HEAL_SHARE;
  const out: string[] = [];
  w.items = w.items.map((it) => {
    const use = it.onUse;
    if (!use || (it.useMode !== 'consumed' && it.useMode !== 'charges') || it.rarity === 'unique') return it;
    const pr = itemProfile(w, it);
    if (pr.heal <= 0 || pr.offensive || pr.selfHarm || pr.heal >= want || pr.heal < hp * HEAL_ITEM_SHARE) return it;
    const f = want / pr.heal;
    // a new object: itemProfile caches per def object
    const next: ItemDef = { ...it, onUse: { ...use, effects: use.effects.map((e) => (e.type === 'heal' ? { ...e, amount: scaleAmount(e.amount, f) } : e)) } };
    out.push(`${it.id} ${Math.round(pr.heal * 10) / 10}→${Math.round(itemProfile(w, next).heal * 10) / 10}`);
    return next;
  });
  if (out.length) changes.push(`healing items heal at least ${Math.round(MIN_HEAL_SHARE * 100)}% of max hp (${out.join(', ')})`);
}

/**
 * The new-player fixes, re-validated: the first area spawns at most a few hostiles (none that
 * outrange everything the player starts with), and healing consumables heal about a quarter of the
 * player's max hp. Returns the input world itself when nothing changed.
 */
export function newPlayerFixes(world: WorldSpec): RebalanceResult {
  const w = structuredClone(world) as WorldSpec;
  const changes: string[] = [];
  firstAreaFixes(w, changes);
  scaleHeals(w, changes);
  if (!changes.length) return { world, changes: ['no changes'], valid: true };
  const parsed = parseWorld(JSON.parse(JSON.stringify(w)));
  if (!parsed.ok) return { world, changes: [...changes, `rejected: adjusted world failed validation (${parsed.errors.slice(0, 3).join('; ')})`], valid: false };
  return { world: parsed.world, changes, valid: true };
}
