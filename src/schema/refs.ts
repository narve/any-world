/**
 * Cross-reference validation for World Specs.
 *
 * zod checks the *shape* of a world; this module checks that every id used anywhere points at
 * something that exists, plus a handful of semantic consistency rules that would otherwise make
 * a world crash, soft-lock or behave nonsensically (unknown items without appearances, weapons
 * without attacks, win conditions that can never become true, …).
 *
 * All messages are human readable and start with a path, so they can be fed straight back to an
 * LLM as repair feedback.
 *
 * Built-ins that need no declaration:
 *  - damage type "physical" (it is the schema default for attacks and damage effects)
 *  - stat refs: str, dex, int, hp, mp, ac, speed, sight
 *  - remove_status "all_harmful"
 */
import { z } from 'zod';
import {
  WorldSpec,
  type Action,
  type Condition,
  type Effect,
  type ModelSpec,
  type Trigger,
} from './world';

export const BUILTIN_DAMAGE_TYPES = ['physical'] as const;
export const BUILTIN_STATS = ['str', 'dex', 'int', 'hp', 'mp', 'ac', 'speed', 'sight'] as const;

type WorldSpecT = z.infer<typeof WorldSpec>;

interface Ctx {
  world: WorldSpecT;
  errors: string[];
  items: Set<string>;
  actors: Set<string>;
  statuses: Set<string>;
  terrains: Set<string>;
  damageTypes: Set<string>;
  resources: Set<string>;
  /** flags set anywhere by a set_flag effect with value true */
  flagsSet: Set<string>;
  /** counters changed anywhere by a counter effect */
  countersChanged: Set<string>;
}

function q(id: string): string {
  return JSON.stringify(id);
}

function label(kind: string, index: number, id?: string): string {
  return id ? `${kind}[${index}] (${id})` : `${kind}[${index}]`;
}

// ---------------------------------------------------------------------------
// Leaf checks
// ---------------------------------------------------------------------------

function checkStat(ctx: Ctx, path: string, stat: string): void {
  if ((BUILTIN_STATS as readonly string[]).includes(stat)) return;
  if (ctx.resources.has(stat)) return;
  ctx.errors.push(
    `${path}: unknown stat/resource ${q(stat)} (use one of ${BUILTIN_STATS.join(', ')}${
      ctx.resources.size ? ' or a custom resource: ' + [...ctx.resources].join(', ') : ''
    })`,
  );
}

function checkItem(ctx: Ctx, path: string, id: string): void {
  if (!ctx.items.has(id)) ctx.errors.push(`${path}: unknown item ${q(id)}`);
}
function checkActor(ctx: Ctx, path: string, id: string): void {
  if (!ctx.actors.has(id)) ctx.errors.push(`${path}: unknown actor ${q(id)}`);
}
function checkStatus(ctx: Ctx, path: string, id: string): void {
  if (!ctx.statuses.has(id)) ctx.errors.push(`${path}: unknown status ${q(id)}`);
}
function checkTerrain(ctx: Ctx, path: string, id: string): void {
  if (!ctx.terrains.has(id)) ctx.errors.push(`${path}: unknown terrain ${q(id)}`);
}
function checkDamageType(ctx: Ctx, path: string, id: string): void {
  if (!ctx.damageTypes.has(id)) ctx.errors.push(`${path}: unknown damage type ${q(id)}`);
}

function checkAmount(ctx: Ctx, path: string, amount: { scale?: { stat: string } }): void {
  if (amount.scale) checkStat(ctx, `${path}.scale.stat`, amount.scale.stat);
}

// ---------------------------------------------------------------------------
// Recursive walkers
// ---------------------------------------------------------------------------

function checkCondition(ctx: Ctx, path: string, c: Condition): void {
  switch (c.type) {
    case 'all':
    case 'any':
      c.of.forEach((sub, i) => checkCondition(ctx, `${path}.of[${i}]`, sub));
      break;
    case 'not':
      checkCondition(ctx, `${path}.cond`, c.cond);
      break;
    case 'stat':
      checkStat(ctx, `${path}.stat`, c.stat);
      break;
    case 'has_item':
      checkItem(ctx, `${path}.item`, c.item);
      break;
    case 'has_status':
      checkStatus(ctx, `${path}.status`, c.status);
      break;
    case 'actor_defeated':
      checkActor(ctx, `${path}.actor`, c.actor);
      break;
    case 'in_area':
      if (c.area < 0 || c.area >= ctx.world.areas.length) {
        ctx.errors.push(
          `${path}.area: area index ${c.area} is out of range (world has ${ctx.world.areas.length} areas, valid 0..${ctx.world.areas.length - 1})`,
        );
      }
      break;
    case 'on_terrain':
      checkTerrain(ctx, `${path}.terrain`, c.terrain);
      break;
    case 'flag':
    case 'counter':
    case 'turn':
    case 'chance':
    case 'always':
      break;
  }
}

function checkEffect(ctx: Ctx, path: string, e: Effect): void {
  switch (e.type) {
    case 'damage':
      checkAmount(ctx, `${path}.amount`, e.amount);
      checkDamageType(ctx, `${path}.damageType`, e.damageType);
      break;
    case 'heal':
      checkAmount(ctx, `${path}.amount`, e.amount);
      break;
    case 'resource':
      checkStat(ctx, `${path}.resource`, e.resource);
      checkAmount(ctx, `${path}.amount`, e.amount);
      break;
    case 'modify_stat':
      checkStat(ctx, `${path}.stat`, e.stat);
      break;
    case 'apply_status':
      checkStatus(ctx, `${path}.status`, e.status);
      break;
    case 'remove_status':
      if (e.status !== 'all_harmful') checkStatus(ctx, `${path}.status`, e.status);
      break;
    case 'summon':
      checkActor(ctx, `${path}.actor`, e.actor);
      break;
    case 'spawn_terrain':
      checkTerrain(ctx, `${path}.terrain`, e.terrain);
      break;
    case 'spawn_item':
      checkItem(ctx, `${path}.item`, e.item);
      break;
    case 'transform':
      if (!ctx.actors.has(e.into) && !ctx.items.has(e.into)) {
        ctx.errors.push(`${path}.into: unknown actor or item ${q(e.into)}`);
      }
      break;
    default:
      break;
  }
}

function checkEffects(ctx: Ctx, path: string, effects: readonly Effect[]): void {
  effects.forEach((e, i) => checkEffect(ctx, `${path}[${i}]`, e));
}

function checkAction(ctx: Ctx, path: string, a: Action): void {
  if (a.condition) checkCondition(ctx, `${path}.condition`, a.condition);
  checkEffects(ctx, `${path}.effects`, a.effects);
  const t = a.targeting;
  if (t && (t.shape === 'area' || t.shape === 'cone') && t.radius < 1) {
    ctx.errors.push(`${path}.targeting.radius: shape ${q(t.shape)} needs radius >= 1`);
  }
}

function checkTriggers(ctx: Ctx, path: string, triggers: readonly Trigger[]): void {
  triggers.forEach((t, i) => {
    checkAction(ctx, `${path}[${i}].action`, t.action);
    if (t.every !== undefined && t.on !== 'on_turn') {
      ctx.errors.push(`${path}[${i}].every: only meaningful for on: "on_turn" (got ${q(t.on)})`);
    }
  });
}

function checkModel(ctx: Ctx, path: string, m: ModelSpec | undefined): void {
  if (!m) return;
  if (m.archetype === 'humanoid' && !m.humanoid) {
    ctx.errors.push(`${path}: archetype "humanoid" requires "humanoid" params (skin, top, bottom, …)`);
  }
  if ((m.archetype === 'freeform' || m.archetype === 'prop') && m.parts.length === 0 && !m.colors) {
    ctx.errors.push(`${path}: archetype ${q(m.archetype)} needs "parts" or "colors" to be visible`);
  }
}

function checkCost(ctx: Ctx, path: string, cost: { resource: string } | undefined): void {
  if (cost) checkStat(ctx, `${path}.resource`, cost.resource);
}

function checkModifiers(ctx: Ctx, path: string, mods: readonly { stat: string }[]): void {
  mods.forEach((m, i) => checkStat(ctx, `${path}[${i}].stat`, m.stat));
}

// ---------------------------------------------------------------------------
// Collection helpers
// ---------------------------------------------------------------------------

function collectIds(ctx: Ctx, kind: string, list: readonly { id: string }[]): Set<string> {
  const seen = new Set<string>();
  list.forEach((x, i) => {
    if (seen.has(x.id)) ctx.errors.push(`${label(kind, i, x.id)}: duplicate id ${q(x.id)} in ${kind}`);
    seen.add(x.id);
  });
  return seen;
}

/** walk every Effect in the world (for flag/counter discovery). */
function forEachEffect(world: WorldSpecT, fn: (e: Effect) => void): void {
  const action = (a: Action | undefined) => a?.effects.forEach(fn);
  const triggers = (ts: readonly Trigger[]) => ts.forEach((t) => action(t.action));
  world.statuses.forEach((s) => s.perTurn.forEach(fn));
  world.resources.forEach((r) => r.onEmpty.forEach(fn));
  world.rules.forEach((r) => triggers(r.playerTriggers));
  world.items.forEach((it) => {
    action(it.onUse);
    triggers(it.triggers);
  });
  world.actors.forEach((a) => {
    a.abilities.forEach((ab) => action(ab.action));
    triggers(a.triggers);
  });
  world.terrains.forEach((t) => {
    t.onStand.forEach(fn);
    action(t.interact);
  });
  world.player.growth.perks.forEach((p) => triggers(p.triggers));
}

function conditionFlags(c: Condition, out: { flags: string[]; counters: string[]; actors: string[]; items: string[] }): void {
  switch (c.type) {
    case 'all':
    case 'any':
      c.of.forEach((s) => conditionFlags(s, out));
      break;
    case 'not':
      conditionFlags(c.cond, out);
      break;
    case 'flag':
      if (c.value !== false) out.flags.push(c.flag);
      break;
    case 'counter':
      out.counters.push(c.counter);
      break;
    case 'actor_defeated':
      out.actors.push(c.actor);
      break;
    case 'has_item':
      out.items.push(c.item);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Returns a list of human-readable problems with the world's cross references and
 * semantic consistency. An empty list means the world is safe to hand to the engine.
 */
export function validateWorldRefs(world: WorldSpecT): string[] {
  const errors: string[] = [];
  const ctx: Ctx = {
    world,
    errors,
    items: new Set(),
    actors: new Set(),
    statuses: new Set(),
    terrains: new Set(),
    damageTypes: new Set(),
    resources: new Set(),
    flagsSet: new Set(),
    countersChanged: new Set(),
  };

  // --- id sets + duplicates -------------------------------------------------
  ctx.items = collectIds(ctx, 'items', world.items);
  ctx.actors = collectIds(ctx, 'actors', world.actors);
  ctx.statuses = collectIds(ctx, 'statuses', world.statuses);
  ctx.terrains = collectIds(ctx, 'terrains', world.terrains);
  ctx.damageTypes = collectIds(ctx, 'damageTypes', world.damageTypes);
  for (const b of BUILTIN_DAMAGE_TYPES) ctx.damageTypes.add(b);
  ctx.resources = collectIds(ctx, 'resources', world.resources);
  collectIds(ctx, 'rules', world.rules);
  collectIds(ctx, 'player.growth.perks', world.player.growth.perks);

  forEachEffect(world, (e) => {
    if (e.type === 'set_flag' && e.value !== false) ctx.flagsSet.add(e.flag);
    if (e.type === 'counter') ctx.countersChanged.add(e.counter);
  });

  // --- resources --------------------------------------------------------------
  world.resources.forEach((r, i) => {
    const p = label('resources', i, r.id);
    if ((BUILTIN_STATS as readonly string[]).includes(r.id)) {
      errors.push(`${p}: resource id ${q(r.id)} collides with a built-in stat`);
    }
    if (r.start > r.max) errors.push(`${p}: start (${r.start}) is greater than max (${r.max})`);
    checkEffects(ctx, `${p}.onEmpty`, r.onEmpty);
  });

  // --- statuses ---------------------------------------------------------------
  world.statuses.forEach((s, i) => {
    const p = label('statuses', i, s.id);
    checkEffects(ctx, `${p}.perTurn`, s.perTurn);
    checkModifiers(ctx, `${p}.modifiers`, s.modifiers);
  });

  // --- rules ------------------------------------------------------------------
  world.rules.forEach((r, i) => {
    checkTriggers(ctx, `${label('rules', i, r.id)}.playerTriggers`, r.playerTriggers);
  });

  // --- terrains ---------------------------------------------------------------
  world.terrains.forEach((t, i) => {
    const p = label('terrains', i, t.id);
    checkEffects(ctx, `${p}.onStand`, t.onStand);
    if (t.interact) checkAction(ctx, `${p}.interact`, t.interact);
    checkModel(ctx, `${p}.model`, t.model);
  });

  // --- items ------------------------------------------------------------------
  const appearanceUse = new Map<string, string[]>();
  world.items.forEach((it, i) => {
    const p = label('items', i, it.id);
    if (it.onUse) checkAction(ctx, `${p}.onUse`, it.onUse);
    checkCost(ctx, `${p}.cost`, it.cost);
    checkModifiers(ctx, `${p}.modifiers`, it.modifiers);
    checkTriggers(ctx, `${p}.triggers`, it.triggers);
    checkModel(ctx, `${p}.model`, it.model);
    if (it.weapon) checkDamageType(ctx, `${p}.weapon.damageType`, it.weapon.damageType);

    // use modes
    if (it.useMode === 'charges' && it.charges === undefined) {
      errors.push(`${p}: useMode "charges" requires "charges"`);
    }
    if (it.useMode !== 'charges' && it.charges !== undefined) {
      errors.push(`${p}: "charges" is only valid with useMode "charges" (got ${q(it.useMode)})`);
    }
    if (it.useMode !== 'passive' && !it.onUse) {
      errors.push(`${p}: useMode ${q(it.useMode)} requires "onUse" (only passive items may omit it)`);
    }
    if (it.useMode === 'passive' && it.onUse) {
      errors.push(`${p}: passive items do nothing when activated; remove "onUse" or pick another useMode`);
    }
    if (it.stackable && (it.useMode === 'charges' || it.equipSlot)) {
      errors.push(`${p}: stackable items cannot have charges or an equip slot`);
    }

    // equipment consistency
    if (it.category === 'weapon' && it.equipSlot !== 'weapon') {
      errors.push(`${p}: category "weapon" requires equipSlot "weapon"`);
    }
    if (it.category === 'armour' && it.equipSlot !== 'armour') {
      errors.push(`${p}: category "armour" requires equipSlot "armour"`);
    }
    if (it.category === 'trinket' && !it.equipSlot && !it.passiveWhenCarried && it.useMode === 'passive') {
      errors.push(`${p}: passive trinket needs equipSlot "trinket" or passiveWhenCarried=true, otherwise it does nothing`);
    }
    if (it.equipSlot === 'weapon' && !it.weapon) {
      errors.push(`${p}: equipSlot "weapon" requires a "weapon" attack`);
    }
    if (it.weapon && it.equipSlot !== 'weapon') {
      errors.push(`${p}: has "weapon" stats but equipSlot is ${it.equipSlot ? q(it.equipSlot) : 'missing'} (must be "weapon")`);
    }
    if (it.equipSlot === 'armour' && it.armour === undefined) {
      errors.push(`${p}: equipSlot "armour" requires an "armour" value`);
    }
    if (it.armour !== undefined && it.equipSlot !== 'armour') {
      errors.push(`${p}: has "armour" value but equipSlot is ${it.equipSlot ? q(it.equipSlot) : 'missing'} (must be "armour")`);
    }

    // knowledge
    if (it.knowledge === 'unknown') {
      if (!it.appearanceGroup) {
        errors.push(`${p}: knowledge "unknown" requires an "appearanceGroup" (key into unknownAppearances)`);
      }
    }
    if (it.appearanceGroup) {
      if (!world.unknownAppearances[it.appearanceGroup]) {
        errors.push(`${p}.appearanceGroup: unknown appearance group ${q(it.appearanceGroup)} (not in unknownAppearances)`);
      } else {
        const list = appearanceUse.get(it.appearanceGroup) ?? [];
        list.push(it.id);
        appearanceUse.set(it.appearanceGroup, list);
      }
    }
    if (it.knowledge === 'vague' && !it.vagueText) {
      errors.push(`${p}: knowledge "vague" requires "vagueText"`);
    }
    if (it.revealOnUse === 'vague' && !it.vagueText) {
      errors.push(`${p}: revealOnUse "vague" requires "vagueText"`);
    }
  });
  for (const [group, users] of appearanceUse) {
    const pool = world.unknownAppearances[group] ?? [];
    if (pool.length < users.length) {
      errors.push(
        `unknownAppearances.${group}: pool has ${pool.length} appearance(s) but ${users.length} items use it (${users.join(', ')}); add more`,
      );
    }
  }

  // --- actors -----------------------------------------------------------------
  world.actors.forEach((a, i) => {
    const p = label('actors', i, a.id);
    if (a.attack) checkDamageType(ctx, `${p}.attack.damageType`, a.attack.damageType);
    const abilityIds = new Set<string>();
    a.abilities.forEach((ab, j) => {
      const ap = `${p}.abilities[${j}] (${ab.id})`;
      if (abilityIds.has(ab.id)) errors.push(`${ap}: duplicate ability id ${q(ab.id)} on this actor`);
      abilityIds.add(ab.id);
      checkAction(ctx, `${ap}.action`, ab.action);
      checkCost(ctx, `${ap}.cost`, ab.cost);
    });
    a.resistances.forEach((r, j) => checkDamageType(ctx, `${p}.resistances[${j}].damageType`, r.damageType));
    checkTriggers(ctx, `${p}.triggers`, a.triggers);
    a.loot.forEach((l, j) => checkItem(ctx, `${p}.loot[${j}].item`, l.item));
    if (a.npc) a.npc.stock.forEach((s, j) => checkItem(ctx, `${p}.npc.stock[${j}]`, s));
    checkModel(ctx, `${p}.model`, a.model);
  });

  // --- player -----------------------------------------------------------------
  const pl = world.player;
  checkDamageType(ctx, 'player.unarmed.damageType', pl.unarmed.damageType);
  const equippedSlots: Record<string, string> = {};
  pl.startingItems.forEach((s, i) => {
    const p = `player.startingItems[${i}]`;
    checkItem(ctx, `${p}.item`, s.item);
    const def = world.items.find((x) => x.id === s.item);
    if (!def) return;
    if (s.equipped) {
      if (!def.equipSlot) {
        errors.push(`${p}: ${q(s.item)} is marked equipped but has no equipSlot`);
      } else if (equippedSlots[def.equipSlot]) {
        errors.push(`${p}: two starting items equipped in slot ${q(def.equipSlot)} (${equippedSlots[def.equipSlot]}, ${s.item})`);
      } else {
        equippedSlots[def.equipSlot] = s.item;
      }
    }
    if (s.count > 1 && !def.stackable) {
      errors.push(`${p}: count ${s.count} but ${q(s.item)} is not stackable`);
    }
  });
  pl.growth.perks.forEach((perk, i) => {
    const p = label('player.growth.perks', i, perk.id);
    checkModifiers(ctx, `${p}.modifiers`, perk.modifiers);
    perk.grantItems.forEach((g, j) => checkItem(ctx, `${p}.grantItems[${j}]`, g));
    checkTriggers(ctx, `${p}.triggers`, perk.triggers);
  });
  if (pl.growth.perks.length < pl.growth.choices) {
    errors.push(`player.growth: ${pl.growth.perks.length} perks cannot fill ${pl.growth.choices} choices`);
  }
  checkModel(ctx, 'player.model', pl.model);

  // --- areas ------------------------------------------------------------------
  world.areas.forEach((area, i) => {
    const p = `areas[${i}] (${area.name})`;
    area.actors.forEach((s, j) => {
      checkActor(ctx, `${p}.actors[${j}].actor`, s.actor);
      if (s.min > s.max) errors.push(`${p}.actors[${j}]: min (${s.min}) > max (${s.max})`);
    });
    area.placed.forEach((s, j) => checkActor(ctx, `${p}.placed[${j}].actor`, s.actor));
    area.items.forEach((s, j) => checkItem(ctx, `${p}.items[${j}].item`, s.item));
    area.placedItems.forEach((s, j) => checkItem(ctx, `${p}.placedItems[${j}].item`, s.item));
    area.terrain.forEach((s, j) => checkTerrain(ctx, `${p}.terrain[${j}].terrain`, s.terrain));
    if (area.transitionRequires) checkCondition(ctx, `${p}.transitionRequires`, area.transitionRequires);
    checkModel(ctx, `${p}.transitionModel`, area.transitionModel);
  });

  // --- goal -------------------------------------------------------------------
  checkCondition(ctx, 'goal.win', world.goal.win);
  if (world.goal.lose) checkCondition(ctx, 'goal.lose', world.goal.lose);

  // --- reachability of the win / locks ---------------------------------------
  const obtainable = new Set<string>();
  pl.startingItems.forEach((s) => obtainable.add(s.item));
  world.areas.forEach((a) => {
    a.items.forEach((s) => s.weight > 0 && obtainable.add(s.item));
    a.placedItems.forEach((s) => obtainable.add(s.item));
  });
  world.actors.forEach((a) => {
    a.loot.forEach((l) => l.chance > 0 && obtainable.add(l.item));
    a.npc?.stock.forEach((s) => obtainable.add(s));
  });
  pl.growth.perks.forEach((pk) => pk.grantItems.forEach((g) => obtainable.add(g)));
  forEachEffect(world, (e) => {
    if (e.type === 'spawn_item') obtainable.add(e.item);
  });

  const present = new Set<string>();
  world.areas.forEach((a) => {
    a.actors.forEach((s) => s.max > 0 && s.weight > 0 && present.add(s.actor));
    a.placed.forEach((s) => present.add(s.actor));
  });
  forEachEffect(world, (e) => {
    if (e.type === 'summon') present.add(e.actor);
  });

  const checkReachable = (path: string, c: Condition) => {
    const out = { flags: [] as string[], counters: [] as string[], actors: [] as string[], items: [] as string[] };
    conditionFlags(c, out);
    for (const f of out.flags) {
      if (!ctx.flagsSet.has(f)) errors.push(`${path}: flag ${q(f)} is never set by any set_flag effect, so this can never be true`);
    }
    for (const k of out.counters) {
      if (!ctx.countersChanged.has(k)) errors.push(`${path}: counter ${q(k)} is never changed by any counter effect`);
    }
    for (const a of out.actors) {
      if (ctx.actors.has(a) && !present.has(a)) {
        errors.push(`${path}: actor ${q(a)} is never placed, spawned or summoned in any area`);
      }
    }
    for (const it of out.items) {
      if (ctx.items.has(it) && !obtainable.has(it)) {
        errors.push(`${path}: item ${q(it)} cannot be obtained (not placed, spawned, looted, sold or given)`);
      }
    }
  };
  checkReachable('goal.win', world.goal.win);
  world.areas.forEach((area, i) => {
    if (area.transitionRequires) checkReachable(`areas[${i}] (${area.name}).transitionRequires`, area.transitionRequires);
  });

  return errors;
}

// ---------------------------------------------------------------------------
// parseWorld: zod + refs
// ---------------------------------------------------------------------------

/** "areas[0].actors[2].actor" from a zod issue path. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += (out ? '.' : '') + String(seg);
  }
  return out || '(root)';
}

export function formatZodError(err: z.ZodError): string[] {
  const lines: string[] = [];
  const walk = (issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[]) => {
    for (const issue of issues) {
      const full = [...prefix, ...issue.path];
      if (issue.code === 'invalid_union' && 'errors' in issue && Array.isArray(issue.errors) && issue.errors.length) {
        // report the branch with the fewest issues (most likely intended)
        const best = [...issue.errors].sort((a, b) => a.length - b.length)[0];
        if (best && best.length) {
          walk(best, full);
          continue;
        }
      }
      lines.push(`${formatPath(full)}: ${issue.message}`);
    }
  };
  walk(err.issues, []);
  return lines;
}

/**
 * zod silently strips unknown keys. Compare the raw input with the parsed output and report
 * every key that was dropped (usually a typo like "behavior" or "equip_slot").
 */
export function findUnknownKeys(input: unknown, output: unknown, path: PropertyKey[] = []): string[] {
  const out: string[] = [];
  if (Array.isArray(input) && Array.isArray(output)) {
    input.forEach((v, i) => out.push(...findUnknownKeys(v, output[i], [...path, i])));
  } else if (input && output && typeof input === 'object' && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (!(k in o)) out.push(`${formatPath([...path, k])}: unknown key (ignored by the schema; typo?)`);
      else out.push(...findUnknownKeys(v, o[k], [...path, k]));
    }
  }
  return out;
}

export type ParseWorldResult = { ok: true; world: WorldSpecT } | { ok: false; errors: string[] };

export interface ParseWorldOptions {
  /** also fail on keys the schema does not know (default false: they are silently dropped). */
  strictKeys?: boolean;
}

/** Validate unknown JSON as a World Spec: shape (zod, defaults applied) then cross references. */
export function parseWorld(json: unknown, opts: ParseWorldOptions = {}): ParseWorldResult {
  const parsed = WorldSpec.safeParse(json);
  if (!parsed.success) return { ok: false, errors: formatZodError(parsed.error) };
  const errors = opts.strictKeys ? findUnknownKeys(json, parsed.data) : [];
  errors.push(...validateWorldRefs(parsed.data));
  if (errors.length) return { ok: false, errors };
  return { ok: true, world: parsed.data };
}
