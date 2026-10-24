import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseWorld,
  validateWorldRefs,
  findUnknownKeys,
  formatPath,
  WorldSpec,
  Generator,
  TriggerEvent,
  Effect,
  Behaviour,
  ItemDef,
  AreaPlan,
  type WorldSpecInput,
} from '../../src/schema';

const dir = join(__dirname, '..', '..', 'content', 'worlds');
const files = readdirSync(dir).filter((f) => f.startsWith('fixture-') && f.endsWith('.json')).sort();
const raw = (f: string): WorldSpecInput => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const clone = <T>(x: T): T => structuredClone(x);
const parsed = (w: unknown) => WorldSpec.parse(w);

/** run parseWorld and return its errors (or [] if ok). */
function errs(w: unknown): string[] {
  const r = parseWorld(w, { strictKeys: true });
  return r.ok ? [] : r.errors;
}

describe('fixture worlds', () => {
  it('has the four handcrafted fixtures', () => {
    expect(files).toEqual(['fixture-dream.json', 'fixture-ship.json', 'fixture-teen.json', 'fixture-western.json']);
  });

  for (const f of files) {
    describe(f, () => {
      const json = raw(f);
      it('passes parseWorld (strict keys)', () => {
        const r = parseWorld(json, { strictKeys: true });
        if (!r.ok) throw new Error(r.errors.join('\n'));
        expect(r.ok).toBe(true);
      });
      it('meets the size brief (3-4 areas, 8-14 actors, 15-25 items)', () => {
        const w = parsed(json);
        expect(w.areas.length).toBeGreaterThanOrEqual(3);
        expect(w.areas.length).toBeLessThanOrEqual(4);
        expect(w.actors.length).toBeGreaterThanOrEqual(8);
        expect(w.actors.length).toBeLessThanOrEqual(14);
        expect(w.items.length).toBeGreaterThanOrEqual(15);
        expect(w.items.length).toBeLessThanOrEqual(25);
      });
      it('has GM fallback text and a unique boss placed in the final area', () => {
        const w = parsed(json);
        expect(w.gm.fallback.intro.length).toBeGreaterThan(50);
        expect(w.gm.fallback.areaEnter.length).toBeGreaterThanOrEqual(w.areas.length);
        const last = w.areas[w.areas.length - 1];
        const bosses = last.placed.filter((p) => w.actors.find((a) => a.id === p.actor)?.unique);
        expect(bosses.length).toBeGreaterThan(0);
      });
      it('has several NPCs with distinct roles', () => {
        const w = parsed(json);
        const roles = new Set(w.actors.filter((a) => a.npc).map((a) => a.npc!.role));
        expect(roles.size).toBeGreaterThanOrEqual(3);
      });
      it('every humanoid model has humanoid params', () => {
        const w = parsed(json);
        const models = [w.player.model, ...w.actors.map((a) => a.model), ...w.items.map((i) => i.model)];
        for (const m of models) if (m.archetype === 'humanoid') expect(m.humanoid).toBeDefined();
      });
      it('every area has a backdrop', () => {
        const w = parsed(json);
        for (const a of w.areas) expect(a.backdrop, a.name).toBeDefined();
      });
      it('every consumable has a flavoured appearance pool (for unknown / GM-hidden consumables)', () => {
        const w = parsed(json);
        for (const i of w.items.filter((x) => x.category === 'consumable' && x.knowledge !== 'vague')) {
          expect(i.appearanceGroup, i.id).toBeDefined();
          expect(w.unknownAppearances[i.appearanceGroup!]?.length ?? 0, i.id).toBeGreaterThan(0);
        }
      });
      it('appearance labels are unique within the world', () => {
        const w = parsed(json);
        const labels = Object.values(w.unknownAppearances).flat().map((x) => x.label.toLowerCase());
        expect(new Set(labels).size).toBe(labels.length);
      });
    });
  }

  it('dream fixture is thoroughly non-realistic', () => {
    const w = parsed(raw('fixture-dream.json'));
    // one new non-realistic generator per area, at least once each
    expect(new Set(w.areas.map((a) => a.generator))).toEqual(new Set(['islands', 'organic', 'geometric']));
    // a different backdrop style on every area
    const styles = w.areas.map((a) => a.backdrop!.style);
    expect(new Set(styles).size).toBe(w.areas.length);
    // abstract surfaces only
    const abstract = new Set(['gradient', 'grid', 'noise', 'lines', 'none']);
    for (const a of w.areas) {
      expect(abstract.has(a.floor.pattern), a.name).toBe(true);
      expect(abstract.has(a.wall.pattern), a.name).toBe(true);
    }
    // no humanoids anywhere
    const models = [w.player.model, ...w.actors.map((a) => a.model), ...w.items.map((i) => i.model), ...w.terrains.flatMap((t) => (t.model ? [t.model] : []))];
    expect(models.some((m) => m.archetype === 'humanoid')).toBe(false);
    expect(w.player.model.archetype).toBe('freeform');
    // strange custom resources and rule variants
    expect(w.resources.map((r) => r.id).sort()).toEqual(['afterimage', 'hue']);
    expect(w.resources.find((r) => r.id === 'hue')!.perTurn).toBeLessThan(0);
    expect(w.rules.some((r) => r.switches.allConsumablesUnknown)).toBe(true);
    expect(w.rules.some((r) => r.switches.violenceCounter === 'colours-spilled')).toBe(true);
    expect(w.rules.some((r) => r.playerTriggers.some((t) => t.action.effects.some((e) => e.type === 'teleport')))).toBe(true);
    // unusual goal: a pacifist ending (flag from a quest item) OR defeating the boss, and a lose condition on the violence counter
    expect(w.goal.win.type).toBe('any');
    expect(w.goal.lose).toEqual({ type: 'counter', counter: 'colours-spilled', cmp: 'gte', value: expect.any(Number) });
    const brush = w.items.find((i) => i.id === 'last-brushstroke')!;
    expect(brush.onUse!.effects).toContainEqual({ type: 'set_flag', flag: 'horizon-finished', value: true });
    // every consumable is hidden by the rule and has a label to hide behind
    const consumables = w.items.filter((i) => i.category === 'consumable');
    expect(consumables.length).toBeGreaterThanOrEqual(5);
    expect(w.unknownAppearances.blot.length).toBeGreaterThanOrEqual(consumables.length);
    // vocabulary never assumes a person
    expect(w.vocabulary.stats.hp.name).toBe('Opacity');
    expect(w.vocabulary.conflict).not.toBe('Attack');
  });

  it('teen fixture is non-violent with renamed conflict and persuasion', () => {
    const w = parsed(raw('fixture-teen.json'));
    expect(w.meta.nonViolent).toBe(true);
    expect(w.vocabulary.stats.hp.name).toBe('Composure');
    expect(w.vocabulary.conflict).not.toBe('Attack');
    expect(w.verbs.talk && w.verbs.persuade).toBe(true);
    expect(w.actors.filter((a) => a.npc).length).toBeGreaterThanOrEqual(6);
  });

  it('ship fixture drains a custom resource and enables sneak', () => {
    const w = parsed(raw('fixture-ship.json'));
    expect(w.resources.some((r) => r.perTurn < 0)).toBe(true);
    expect(w.verbs.sneak).toBe(true);
    expect(w.items.some((i) => i.knowledge === 'unknown')).toBe(true);
  });

  it('collectively exercise the schema building blocks', () => {
    const worlds = files.map((f) => parsed(raw(f)));
    const generators = new Set<string>();
    const useModes = new Set<string>();
    const knowledge = new Set<string>();
    const triggerEvents = new Set<string>();
    const effectTypes = new Set<string>();
    const behaviours = new Set<string>();
    const archetypes = new Set<string>();
    const shapes = new Set<string>();
    const categories = new Set<string>();
    const npcRoles = new Set<string>();
    const statusFlags = new Set<string>();
    const condTypes = new Set<string>();

    const walk = (v: unknown, key?: string): void => {
      if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
      if (!v || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      if (key === 'effects' || key === 'perTurn' || key === 'onStand' || key === 'onEmpty') {
        if (typeof o.type === 'string') effectTypes.add(o.type);
      }
      if ((key === 'condition' || key === 'win' || key === 'lose' || key === 'transitionRequires' || key === 'of' || key === 'cond') && typeof o.type === 'string') {
        condTypes.add(o.type);
      }
      if (typeof o.on === 'string' && 'action' in o) triggerEvents.add(o.on);
      if (key === 'targeting' && typeof o.shape === 'string') shapes.add(o.shape);
      if (typeof o.archetype === 'string') archetypes.add(o.archetype);
      for (const [k, x] of Object.entries(o)) walk(x, k);
    };

    for (const w of worlds) {
      walk(w);
      w.areas.forEach((a) => generators.add(a.generator));
      w.items.forEach((i) => {
        useModes.add(i.useMode);
        knowledge.add(i.knowledge);
        categories.add(i.category);
      });
      w.actors.forEach((a) => {
        behaviours.add(a.behaviour.type);
        if (a.npc) npcRoles.add(a.npc.role);
      });
      w.statuses.forEach((s) => s.flags.forEach((f) => statusFlags.add(f)));
    }

    expect([...generators].sort()).toEqual([...Generator.options].sort());
    expect([...useModes].sort()).toEqual(['charges', 'consumed', 'passive', 'reusable']);
    expect([...knowledge].sort()).toEqual(['clear', 'unknown', 'vague']);
    expect([...triggerEvents].sort()).toEqual([...TriggerEvent.options].sort());
    const allEffects = Effect.options.map((o) => o.shape.type.value as string);
    expect([...effectTypes].sort()).toEqual([...allEffects].sort());
    expect([...behaviours].sort()).toEqual([...Behaviour.shape.type.options].sort());
    expect([...categories].sort()).toEqual([...ItemDef.shape.category.options].sort());
    expect(npcRoles.size).toBe(7);
    expect(shapes.size).toBe(7);
    expect(archetypes.has('humanoid') && archetypes.has('robot') && archetypes.has('freeform')).toBe(true);
    expect(archetypes.size).toBeGreaterThanOrEqual(9);
    expect(statusFlags.size).toBeGreaterThanOrEqual(10);
    for (const t of ['all', 'any', 'has_item', 'actor_defeated', 'in_area', 'counter', 'flag', 'chance']) expect(condTypes).toContain(t);

    // M2: non-realistic building blocks (generators are covered above via Generator.options)
    const patterns = new Set(worlds.flatMap((w) => w.areas.flatMap((a) => [a.floor.pattern, a.wall.pattern])));
    for (const p of ['gradient', 'grid', 'noise', 'lines', 'none']) expect(patterns, `surface pattern ${p}`).toContain(p);
    const backdrops = new Set(worlds.flatMap((w) => w.areas.flatMap((a) => (a.backdrop ? [a.backdrop.style] : []))));
    expect([...backdrops].sort()).toEqual([...AreaPlan.shape.backdrop.unwrap().shape.style.unwrap().options].sort());
  });
});

describe('validateWorldRefs on broken copies', () => {
  const base = raw('fixture-western.json');
  const teen = raw('fixture-teen.json');
  const ship = raw('fixture-ship.json');

  it('accepts the unmodified world', () => {
    expect(validateWorldRefs(parsed(base))).toEqual([]);
  });

  it('reports an unknown item in an area spawn table', () => {
    const w = clone(base);
    w.areas[0].items[0].item = 'no-such-item';
    const e = errs(w);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/areas\[0\].*items\[0\]\.item: unknown item "no-such-item"/);
  });

  it('reports unknown ids deep inside nested effects, conditions and triggers', () => {
    const w = clone(base);
    const vane = w.actors.find((a) => a.id === 'absalom-vane')!;
    vane.abilities![0].action.effects[1] = { type: 'apply_status', status: 'ghost-status', duration: 2 };
    vane.abilities![1].action.effects[0] = { type: 'summon', actor: 'ghost-actor', count: 1, allied: false };
    vane.triggers![0].action.condition = { type: 'all', of: [{ type: 'not', cond: { type: 'on_terrain', who: 'self', terrain: 'ghost-terrain' } }] };
    const e = errs(w);
    expect(e.some((x) => /abilities\[0\].*effects\[1\]\.status: unknown status "ghost-status"/.test(x))).toBe(true);
    expect(e.some((x) => /abilities\[1\].*effects\[0\]\.actor: unknown actor "ghost-actor"/.test(x))).toBe(true);
    expect(e.some((x) => /triggers\[0\]\.action\.condition\.of\[0\]\.cond\.terrain: unknown terrain "ghost-terrain"/.test(x))).toBe(true);
  });

  it('reports unknown damage types, stats and resources', () => {
    const w = clone(base);
    w.items[0].weapon!.damageType = 'plasma';
    w.actors[0].resistances = [{ damageType: 'plasma', multiplier: 2 }];
    w.items.find((i) => i.id === 'trick-shot')!.cost = { resource: 'bullets', amount: 1 };
    w.statuses![0].modifiers = [{ stat: 'luck', amount: 1 }];
    const e = errs(w);
    expect(e.filter((x) => x.includes('unknown damage type "plasma"'))).toHaveLength(2);
    expect(e.some((x) => x.includes('cost.resource: unknown stat/resource "bullets"'))).toBe(true);
    expect(e.some((x) => x.includes('modifiers[0].stat: unknown stat/resource "luck"'))).toBe(true);
  });

  it('allows the built-in "physical" damage type even when undeclared', () => {
    const w = clone(base);
    w.damageTypes = w.damageTypes.filter((d) => d.id !== 'physical');
    expect(errs(w)).toEqual([]);
  });

  it('reports dangling refs in loot, placed, startingItems, npc stock and perk grants', () => {
    const w = clone(base);
    w.actors[0].loot = [{ item: 'x-loot', chance: 0.5 }];
    w.areas[0].placed![0].actor = 'x-placed';
    w.player.startingItems[2].item = 'x-start';
    w.actors.find((a) => a.npc)!.npc!.stock = ['x-stock'];
    w.player.growth.perks[3].grantItems = ['x-grant'];
    w.areas[1].placedItems![0].item = 'x-placeditem';
    const e = errs(w).join('\n');
    for (const id of ['x-loot', 'x-placed', 'x-start', 'x-stock', 'x-grant', 'x-placeditem']) expect(e).toContain(`"${id}"`);
  });

  it('reports duplicate ids', () => {
    const w = clone(base);
    w.items.push(clone(w.items[1]));
    w.statuses!.push(clone(w.statuses![0]));
    w.player.growth.perks.push(clone(w.player.growth.perks[0]));
    const e = errs(w);
    expect(e.some((x) => x.includes('duplicate id "pick-handle" in items'))).toBe(true);
    expect(e.some((x) => x.includes('duplicate id "parched" in statuses'))).toBe(true);
    expect(e.some((x) => x.includes('duplicate id "quick-draw"'))).toBe(true);
  });

  it('reports unknown items without appearanceGroup and undersized appearance pools', () => {
    const w = clone(base);
    delete w.items.find((i) => i.id === 'snake-oil')!.appearanceGroup;
    w.unknownAppearances!.tonic = w.unknownAppearances!.tonic.slice(0, 1);
    const e = errs(w);
    expect(e.some((x) => x.includes('(snake-oil): knowledge "unknown" requires an "appearanceGroup"'))).toBe(true);
    expect(e.some((x) => /unknownAppearances\.tonic: pool has 1 appearance\(s\) but 4 items/.test(x))).toBe(true);
  });

  it('reports a missing appearance group', () => {
    const w = clone(base);
    w.items.find((i) => i.id === 'laudanum')!.appearanceGroup = 'pills';
    expect(errs(w).some((x) => x.includes('unknown appearance group "pills"'))).toBe(true);
  });

  it('reports equipSlot / weapon / armour inconsistencies', () => {
    const w = clone(base);
    const gun = w.items.find((i) => i.id === 'peacemaker')!;
    delete gun.equipSlot;
    const coat = w.items.find((i) => i.id === 'buffalo-coat')!;
    delete coat.armour;
    const charm = w.items.find((i) => i.id === 'lucky-horseshoe')!;
    charm.armour = 2;
    const e = errs(w).join('\n');
    expect(e).toContain('(peacemaker): category "weapon" requires equipSlot "weapon"');
    expect(e).toContain('(peacemaker): has "weapon" stats but equipSlot is missing');
    expect(e).toContain('(buffalo-coat): equipSlot "armour" requires an "armour" value');
    expect(e).toContain('(lucky-horseshoe): has "armour" value but equipSlot is "trinket"');
  });

  it('reports use-mode problems', () => {
    const w = clone(base);
    delete w.items.find((i) => i.id === 'canteen')!.charges;
    delete w.items.find((i) => i.id === 'sarsaparilla')!.onUse;
    w.items.find((i) => i.id === 'lode-key')!.charges = 3;
    const e = errs(w).join('\n');
    expect(e).toContain('(canteen): useMode "charges" requires "charges"');
    expect(e).toContain('(sarsaparilla): useMode "consumed" requires "onUse"');
    expect(e).toContain('(lode-key): "charges" is only valid with useMode "charges"');
  });

  it('reports starting equipment problems', () => {
    const w = clone(base);
    w.player.startingItems.push({ item: 'scattergun', count: 1, equipped: true, quick: true });
    w.player.startingItems[3].equipped = true; // canteen has no slot
    const e = errs(w).join('\n');
    expect(e).toContain('two starting items equipped in slot "weapon"');
    expect(e).toContain('"canteen" is marked equipped but has no equipSlot');
  });

  it('reports humanoid archetypes without humanoid params', () => {
    const w = clone(base);
    delete w.actors.find((a) => a.id === 'company-deputy')!.model.humanoid;
    delete w.player.model.humanoid;
    const e = errs(w);
    expect(e.some((x) => x.includes('(company-deputy).model: archetype "humanoid" requires "humanoid" params'))).toBe(true);
    expect(e.some((x) => x.startsWith('player.model: archetype "humanoid"'))).toBe(true);
  });

  it('reports out-of-range area indexes in conditions', () => {
    const w = clone(teen);
    w.items.find((i) => i.id === 'speech-notebook')!.onUse!.condition = { type: 'in_area', area: 7 };
    const e = errs(w);
    expect(e.some((x) => /speech-notebook\)\.onUse\.condition\.area: area index 7 is out of range \(world has 3 areas/.test(x))).toBe(true);
  });

  it('reports win conditions that can never be satisfied', () => {
    const w = clone(ship);
    w.goal.win = {
      type: 'all',
      of: [
        { type: 'flag', flag: 'never-set' },
        { type: 'counter', counter: 'never-counted', cmp: 'gte', value: 1 },
        { type: 'actor_defeated', actor: 'archivist-pell' },
        { type: 'has_item', who: 'player', item: 'arrival-log' },
      ],
    };
    w.areas[2].placedItems = [];
    // archivist-pell is placed in area 0 so it is reachable; remove that placement
    w.areas[0].placed = w.areas[0].placed!.filter((p) => p.actor !== 'archivist-pell');
    const e = errs(w).join('\n');
    expect(e).toContain('flag "never-set" is never set');
    expect(e).toContain('counter "never-counted" is never changed');
    expect(e).toContain('actor "archivist-pell" is never placed');
    expect(e).toContain('item "arrival-log" cannot be obtained');
  });

  it('reports custom resource problems', () => {
    const w = clone(ship);
    w.resources![0].start = 500;
    w.resources!.push({ id: 'hp', name: 'Dup', description: 'x', color: '#fff', max: 5, start: 1 });
    const e = errs(w).join('\n');
    expect(e).toContain('start (500) is greater than max (120)');
    expect(e).toContain('resource id "hp" collides with a built-in stat');
  });

  it('reports spawn-table min > max', () => {
    const w = clone(teen);
    w.areas[0].actors[0].min = 9;
    w.areas[0].actors[0].max = 2;
    expect(errs(w).some((x) => x.includes('min (9) > max (2)'))).toBe(true);
  });
});

describe('parseWorld', () => {
  const base = raw('fixture-teen.json');

  it('reports zod shape errors with readable paths', () => {
    const w = clone(base) as Record<string, any>;
    w.actors[2].stats.hp = 0;
    w.palette.primary = 'pink';
    w.areas[1].generator = 'spaceport';
    const r = parseWorld(w);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((x) => x.startsWith('actors[2].stats.hp:'))).toBe(true);
    expect(r.errors.some((x) => x.startsWith('palette.primary:'))).toBe(true);
    expect(r.errors.some((x) => x.startsWith('areas[1].generator:'))).toBe(true);
  });

  it('reports errors inside discriminated unions at the right path', () => {
    const w = clone(base) as Record<string, any>;
    w.items[0].weapon.damage.dice = 'lots';
    w.goal.win.of[1].of[0].area = -1;
    const r = parseWorld(w);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((x) => x.startsWith('items[0].weapon.damage.dice:'))).toBe(true);
    expect(r.errors.some((x) => x.startsWith('goal.win.of[1].of[0].area:'))).toBe(true);
  });

  it('returns ref errors after a successful shape parse', () => {
    const w = clone(base);
    w.areas[0].placed![0].actor = 'nobody';
    const r = parseWorld(w);
    expect(r).toEqual({ ok: false, errors: [expect.stringContaining('unknown actor "nobody"')] });
  });

  it('ignores unknown keys by default but reports them with strictKeys', () => {
    const w = clone(base) as Record<string, any>;
    w.actors[0].behavior = { type: 'chaser' };
    w.meta.sequel = true;
    expect(parseWorld(w).ok).toBe(true);
    const r = parseWorld(w, { strictKeys: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContain('actors[0].behavior: unknown key (ignored by the schema; typo?)');
    expect(r.errors).toContain('meta.sequel: unknown key (ignored by the schema; typo?)');
  });

  it('applies defaults in the returned world', () => {
    const r = parseWorld(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.world.actors[0].abilities).toEqual([]);
    expect(r.world.items.every((i) => typeof i.cooldown === 'number')).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(parseWorld(null).ok).toBe(false);
    expect(parseWorld('world').ok).toBe(false);
  });

  it('formatPath / findUnknownKeys helpers', () => {
    expect(formatPath(['areas', 0, 'actors', 2, 'actor'])).toBe('areas[0].actors[2].actor');
    expect(formatPath([])).toBe('(root)');
    expect(findUnknownKeys({ a: 1, b: { c: 2, d: 3 } }, { a: 1, b: { c: 2 } })).toEqual(['b.d: unknown key (ignored by the schema; typo?)']);
  });
});
