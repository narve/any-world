/**
 * World-generation prompt (DESIGN §3.0, §4.1, §7b). `buildWorldPrompt` returns the exact system and
 * user message the game sends; `worldRequest` wraps them in a CompletionRequest. tools/print-prompt.ts
 * prints the same thing for agents acting as the provider.
 *
 * No JSON Schema is attached to the request: the full World Spec schema is ~110k characters, so the
 * prompt carries a condensed TypeScript-style description generated from the zod contract
 * (world-schema.ts), and the pipeline validates with zod + validateWorldRefs and repairs.
 */
import type { CompletionRequest } from '../types';
import type { Difficulty } from '../../schema/gm';
import { WORLD_SCHEMA_DOC, SCHEMA_NOTATION } from './world-schema';
import { JSON_ONLY, clamp01, difficultyGuidance, languageInstruction, languageName, normaliseLanguage, seededRandom, weirdnessBand } from './common';

export interface WorldPromptOptions {
  /** the player's prompt; empty / missing = surprise me */
  prompt?: string;
  /** BCP-47 language of all player-facing text (default "en") */
  language?: string;
  difficulty?: Difficulty;
  /** 0 familiar … 1 unhinged (default 0.5) */
  weirdness?: number;
  /** seed for the surprise-me draw (genre × era × tone × twist); default derived from the prompt */
  surpriseSeed?: number;
  /** titles / premises of recent worlds the player has seen, to steer away from them */
  recentWorlds?: string[];
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

/** output budget for a world: a full spec is ~15–25k tokens */
export const WORLD_MAX_TOKENS = 32_000;
export const WORLD_TEMPERATURE = 1;
export const WORLD_SCHEMA_NAME = 'world_spec';

// ---------------------------------------------------------------------------
// Surprise me
// ---------------------------------------------------------------------------

export const SURPRISE_GENRES = [
  'frontier western', 'generation-ship mystery', 'teen social drama', 'noir investigation', 'Viking saga',
  'cozy village life', 'cosmic horror', 'heist', 'courtroom drama', 'post-collapse road trip',
  'deep-sea expedition', 'mythic odyssey', 'office satire', 'sports underdog story', 'pirate voyage',
  'spy thriller', 'monster-hunting on a budget', 'abstract art adventure', 'inside a living body', 'psychedelic dream',
  'alien biology survey', 'ghost story', 'kaiju aftermath', 'archaeological dig', 'carnival of the uncanny',
  'mountain rescue', 'bureaucratic fantasy', 'micro-scale world (insects, dust)', 'music and sound world', 'time-loop farce',
] as const;

export const SURPRISE_ERAS = [
  'bronze age', 'the 1920s', 'a near future', 'the far future', 'medieval Iceland', 'the 1970s', 'the 1990s',
  'a timeless dream', 'the last day of an era', 'prehistory', 'the 19th century', 'a world without history',
  'the Edo period', 'the space age', 'right now',
] as const;

export const SURPRISE_TONES = [
  'melancholic', 'absurd', 'tense', 'tender', 'grim', 'whimsical', 'eerie', 'hopeful', 'satirical', 'feverish',
  'quiet', 'operatic', 'deadpan', 'bittersweet',
] as const;

export const SURPRISE_TWISTS = [
  'the player is the villain of someone else\'s story', 'nobody may be harmed: conflict is social', 'the map itself is alive',
  'light is a resource that runs out', 'every item is a memory', 'gravity points sideways', 'the hero is very small',
  'the enemies are misunderstood', 'time runs backwards in one area', 'colours have rules', 'the goal is to protect someone',
  'the goal is to escape, not to win a fight', 'money is literally time', 'the world is a painting being finished',
  'everyone is lying except the animals', 'the dead keep working', 'the world ends at sunset', 'you are moving house',
] as const;

export interface SurpriseDraw {
  genre: string;
  era: string;
  tone: string;
  twist: string;
}

/** deterministic genre × era × tone × twist draw (DESIGN §3.0 "Surprise me") */
export function surpriseDraw(seed: number): SurpriseDraw {
  const r = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length]!;
  return { genre: pick(SURPRISE_GENRES), era: pick(SURPRISE_ERAS), tone: pick(SURPRISE_TONES), twist: pick(SURPRISE_TWISTS) };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const ROLE = `You are the world designer of AnyWorld, a turn-based roguelike in which no two runs are the same game, or even the same genre. For each run you invent one complete world and write it as a single JSON "World Spec". The game engine runs it: you never write code, you compose the engine's building blocks. Everything you write is validated; invalid output is sent back to you with the exact problems.

A run is short (about 15 minutes): 3–5 areas on a grid, permadeath, fog of war, a final objective in the last area. The player moves one tile per turn, bumps into hostiles to use the world's conflict verb, picks up and uses items from 8 quick slots and a 20-slot backpack, levels up by picking perks, and talks to NPCs. A live game master (another AI) narrates and adds events during play, using your gm notes and threads.`;

const CREATIVE = `CREATIVE BRIEF
- Genre freedom. Fantasy dungeons are one option among many: westerns, sci-fi, school or teen drama, Vikings, noir, historical, surreal, cozy, horror and mash-ups. Follow the player's prompt faithfully, then make it specific.
- Worlds do not have to be realistic or Earth-like: alien planets, the inside of a giant, a dream, abstract art made of shapes and colours. Nothing assumes gravity, a sky, people or sensible architecture. Use the "islands", "organic" and "geometric" generators, abstract surface patterns (gradient, grid, noise, lines, none) and backdrops (starfield, abyss, aurora, grid…) for non-realistic places.
- Avoid clichés. No evil wizard in a dungeon, no generic orcs, no chosen one, no amnesia opening, no "ancient evil awakens". Prefer one surprising angle, concrete sensory details, specific names, and a twist the player discovers. Every actor and item should feel like it could only exist in this world.
- Conflict does not have to be violent. Reskin it with the vocabulary: hp can be "Composure" and the conflict verb "Put-down" in a teen drama, or "Nerve" and "Interrogate" in a detective story; defeated rivals are "outwitted", not killed. Mechanically it is the same tactical system. Switch on non-combat verbs where they fit: talk, persuade (stat check), sneak (noise and detection), search (clues). Set meta.nonViolent=true when conflict is mostly non-violent.
- Win conditions vary. Combine Conditions: defeat a unique (actor_defeated), reach a place (in_area + flag set by an interaction), escape (in_area of the last area + has_item key), collect (has_item with count), survive (turn gte N in the last area), solve (all of several clue items or flags), protect (a lose condition: actor_defeated of a friendly NPC). Offer an alternative non-violent path to victory when it suits the world (goal.win as "any" of two routes).
- The player sees the goal as a checklist built from your conditions: items and actors show their names, but a flag or counter shows only what you put in goal.labels (e.g. {"herd-rejoined": "The herd is whole again"}). Label every flag and counter the goal or a lock uses, in the world's language, and let goal.summary name every route to victory.
- Endings: goal.winText is the winning ending. If the world has goal.lose or an emptyIsDeath resource it can be lost two ways, so write both: goal.lossText for that loss (time runs out, the herd breaks) and goal.deathText for the player being defeated in a fight or by harm. Without either, goal.lossText alone is the defeat ending.
- Give the world a voice: a game-master persona that belongs to it (a weary dispatcher, the house itself, a chorus of gulls), threads to weave in, and fallback narration lines that are good enough to read on their own.`;

const BUILDING_BLOCKS = `HOW THE ENGINE USES YOUR BLOCKS
- Stats: str (melee damage, carrying), dex (to-hit, evasion, ranged), int (ability power, mana), hp, mp, ac (armour class). Rename and reflavour all six in vocabulary.stats; at most 2 custom resources (e.g. Sanity, Oil, Battery) which effects, costs and conditions can use by id.
- Custom resources belong to the player only. perTurn may be fractional (-0.25 = one point every 4 turns). onEmpty runs when the resource reaches 0, then again every 5 turns while it stays at 0 if perTurn is negative; an on_resource_empty trigger fires at the same moment, so use one of the two, not both. A resource changes nothing by itself (not even light): its consequences are what onEmpty, conditions and goal.lose say ({type:"stat", stat:"<resource id>", cmp:"lte", value:0} works as a lose condition).
- Combat: d20 + stat modifier vs the target's ac; natural 20 crits. Damage is an Amount (base + dice + factor × stat), multiplied by resistances. Monsters without an attack use a weak 1d3 strike.
- Items: generic slots, no slot is reserved. useMode consumed (potions, used up; identical ones stack when stackable), charges (N uses), reusable (costs mp/resource or has a cooldown: spells, tools), passive (works while equipped or, with passiveWhenCarried, while carried). At most one weapon, one armour, one trinket equipped. Spells and learned abilities are items too (category "spell", useMode reusable, cost mp). Keys and clues the player only carries: category "key"/"clue", useMode passive, passiveWhenCarried true. Using an item whose onUse condition does not hold still spends it (the use, charge, cost and cooldown) and only says "nothing obvious happened", so say in its description where it works. A spawn_item effect drops the item on the floor next to the target, never into the pack.
- Item knowledge: clear (exact effect shown), vague (only vagueText: flavour without numbers that honestly hints at the effect), unknown (only a random appearance from unknownAppearances[appearanceGroup], like classic unidentified potions; can be good or bad). Using an item reveals it (revealOnUse). Use a few vague / unknown items for discovery, never for the key items of the goal.
- Effects run through an Action: targeting (self, single, adjacent, ray, cone, area, all_visible; range; radius ≥1 for area/cone; affects enemies/allies/all/self_only) + optional condition + up to 8 effects. A healing potion is targeting {shape:"self", affects:"self_only"} with a heal effect.
- Triggers: items, actors, perks and rule variants can react to events (on_hit, on_hurt, on_kill, on_death, on_turn with every N, on_enter_tile, on_pickup, on_equip, on_unequip, on_area_enter, on_resource_empty, on_low_hp). In an actor's on_hit / on_hurt trigger the other party is the target, so affects "enemies" lands on the player.
- Statuses: harmful or helpful, per-turn effects, stat modifiers and engine flags (stunned, rooted, invisible, confused, silenced, afraid, charmed, hasted, slowed, blinded, regenerating). Declare every status you apply.
- Behaviours: chaser, kiter (param = preferred distance), coward (param = flee hp fraction), pack, ambusher, wanderer, guardian (param = radius), stationary, follower, idle. Mix them per area so fights differ. Pitfalls that stall play: a kiter needs open ground and must be catchable (param ≤ 2 and speed ≤ 90, or erratic ≥ 0.2), never on islands or in narrow organic tubes; a guardian only fights inside its radius, so pair guardians with chasers and never let one sit on an item the player must take (use an ambusher there); prefer slow ranged chasers to stationary turrets. Stun, confuse and root effects need a cooldown of 4 or more, or a boss can be locked down.
- Factions: neutral actors never fight anyone; friendly actors fight only when they are the player's allies (a recruited ally or an allied summon).
- NPCs: an actor with an npc block can be talked to. What the role does in play: trader sells its stock for currency and buys what the player carries; quest_giver hands over the first item of its stock once ("Offer to help", +10 xp); healer heals half the player's hp and clears harmful statuses once; ally can be recruited to follow and fight; lore, informant and rival only talk. stock does nothing for any other role, so never put a needed item in an informant's stock. Give each NPC a personality, a greeting, 2–4 canned lines, and what they know (secrets) and want (wants) so the game master can voice them. A unique hostile with an npc block is a boss the player can talk to before the fight.
- Persuade (when verbs.persuade is on) is a stat check: success turns a hostile neutral (it stops fighting), a neutral friendly, a friendly ally-role NPC into an ally. A persuaded actor is not defeated, so actor_defeated never fires for it: if the boss can be persuaded, the other route to victory must be guaranteed (its items placed, or required by the exit locks so the player already holds them).
- Rule variants (1–3): a named twist with global playerTriggers and engine switches (durability, noNaturalHpRegen, allConsumablesUnknown, noLoot, darkness, violenceCounter, permadeathMercy), e.g. "light runs out", "every kill spreads corruption". The player sees them in a Rules panel, so the description must say plainly what happens.
- Areas: each area has a generator and params (table below), floor/wall surfaces, lighting, a weighted spawn table, guaranteed placements (bosses, NPCs, keys, clues, goal items), terrain features, a themed transition ("Board the 6:15 train", "Wake up one layer deeper") and an optional lock (transitionRequires). The last area's transition is never needed: the goal ends the run. placedItems where "guarded" puts the item within 2 tiles of the area's strongest hostile (a unique one first).
- Terrain: scattered at random by density; any density > 0 gives at least one tile, but you cannot choose where, so a must-exist spot (an altar, the signature, a console) belongs in placedItems as an item. onStand runs every turn someone stands there: use it for hazards and slow ground, never for healing or restoring a resource (it would be farmed). interact is a one-time use from the tile or next to it (the terrain need not be walkable); while its condition (other than chance) does not hold, the tile stays usable.
- Backdrop: give every area one; it is all the player sees beyond the walls and through void tiles. For starfield, abyss, aurora and grid, color is the dark base and color2 the stars / motes / curtains / lines; gradient runs from color to color2; clouds and noise blend the two. A bright color on those dark styles floods the whole sky.
- Models: every actor, item and the player has a model. Use the humanoid archetype (with humanoid params: build, outfit, headwear, holding…) for people so they read clearly; quadruped, flier, blob, serpent, vehicle, robot and plant for creatures and machines (give colors); prop for objects; freeform (parts only) for truly odd things. Keep parts to a handful; colours must contrast with the area floor.`;

const GENERATORS = `MAP GENERATORS (AreaPlan.generator) AND THEIR params KNOBS (all optional; out-of-range values are clamped; size small/medium/large scales the map)
- rooms: rectangular rooms joined by winding corridors with doors. roomCount 2..30, roomMin 2..8, roomMax 3..16, loops 0..1 (extra corridors).
- caves: cellular-automaton caverns and tunnels, occasional pools. openness 0..1 (0.5), smoothing 2..8, pools 0..1 (chance).
- open: an irregular open field with scattered cover and ponds (prairie, beach, plaza, tundra). cover 0..0.5 (0.08), rockiness 0..1, ponds 0..4.
- town: streets and walled buildings with doors (a frontier town, a city block, a market). buildings 1..40, streetWidth 2..5, crossStreets 0..3.
- building: one interior: a hallway with rooms of varied size (school, hotel, office, manor). corridorWidth 1..4, crossHalls 0..3.
- ship: a hull with a central corridor, bulkheads and mirrored compartments (starship deck, longship, submarine, train). corridorWidth 1 or 3, symmetry 0..1.
- maze: a braided maze with a few chambers (archives, hedge maze, ducts). loops 0..0.6, chambers 0..8, deadEnds 0..1.
- arena: a big central floor with a pillar lattice and side rooms (boss halls, courts, stages). pillars (count) or pillarDensity 0..1, sideRooms 0..1.
- islands: floating platforms over a void joined by 1-wide bridges (sky islands, stepping stones, asteroid field). islandCount 3..24, islandSize 0..1, bridgeLength 2..24, loops 0..1, pockets 0..1, outcrops 0..1, rims 0|1. Pair with a backdrop.
- organic: lumpy chambers joined by curving tubes (inside a creature, coral, hive, dream-flesh). chambers 2..16, chamberSize 0..1, tubeWidth 1..4, curl 0..1, loops 0..1, wobble 0..1, nodules 0..1, fluid 0..1, membranes 0..1.
- geometric: abstract symmetric patterns (abstract art, crystal lattices, ritual geometry, data-space). variant 0 rings / 1 hexagons / 2 triangles / 3 diamond lattice / 4 kaleidoscope; symmetry 1..4; rings 2..8; spokes 0..12; shape 0..3; cellSize 4..12; facets 3..14; frame 0..3; loops 0..1; pillars 0..1; doors 0..1.
Vary the generator between areas when the story allows; areas are visited in order with no backtracking.`;

const BALANCE = `BALANCE (design for normal difficulty; the engine scales hostile hp and damage for the chosen difficulty and then runs bot simulations; worlds outside the target win rate are rebalanced automatically or sent back to you)
- Player: hp 24–34, mp 10–18, ac 10–12, str/dex/int 8–15 with one clear strength; unarmed 1d3; a starting weapon of about 1d6 (+0..1), one armour or trinket, and 2 healing consumables (heal 6–8). hpRegenEvery 8–12 (0 only if the world has other healing), mpRegenEvery 4–6. Worlds written to the old, more generous numbers came out far too easy (bots won 90%).
- Growth: firstLevelXp 25–35, curve 1.5–1.6, hpPerLevel 4–5, 7–10 perks (stat bumps, a trigger, a spell via grantItems), minLevel spread from 2 to 5.
- Common hostiles: hp 5–12 in the first area, 10–20 later; damage 1d3+1 … 1d6+2; ac 10–13; xp 4–10. Elites: hp 18–26, 1d8+1..2, xp 14–40. Final boss: hp 65–85, ac 13–14, 1d8+3, 1–2 abilities (summons at most 1 helper at a time, cooldown ≥ 12), xp 100+, unique, placed in the last area; a chaser or slow chaser, not a guardian that waits.
- Per area: 3–6 hostile kinds in the spawn table (max 3–5 each), itemCount 5–8, with healing in every area's item table (weights so roughly one heal per three fights; heals from terrain interactions, NPC healers and traders count too). Small last area. At least one friendly or neutral NPC in most areas; a trader whose stock costs ~10–40 currency, plus on_death currency bounties (amount 2–8) on a few hostile kinds or startCurrency 10–30.
- Every goal and lock must be satisfiable: an item a condition asks for must be placed (placedItems), dropped by a placed actor (loot chance 1), sold by a trader or given by a quest_giver, never only made by spawn_item; an actor that must be defeated must be placed in the area where it is needed; a flag must be set by some set_flag effect (an item, a terrain interaction, an on_death trigger); a counter by a counter effect.
- Every route to victory must cost effort inside the last area. A route that holds the moment the player arrives (items already carried + in_area) makes the finale empty: gate it behind a fight (an elite's drop, a guarded item, actor_defeated of the boss's guards) or a counter filled over several turns under pressure. Give each route its own gate.
- Time: a full run takes about 700–1100 turns (≈250 per area; the turn counter is global). Rule variants that drain (per-turn damage, resource loss) must be survivable over that; pair them with a way to restore what they take. Size clocks and deadlines (turn gte N, a resource that fills up) to about 1.3× that, and count resource clocks as a timer, not as damage.`;

const VALIDATION = `VALIDATION RULES (checked automatically; violations are sent back to you)
- ids: lowercase ASCII a-z, 0-9, "-" or "_", starting with a letter or digit, unique within their list. Every id you reference must be declared: items, actors, statuses, terrains, damage types ("physical" is built in), custom resources (StatRef also accepts str, dex, int, hp, mp, ac, speed, sight).
- items: category "weapon" ⇒ equipSlot "weapon" + weapon; category "armour" ⇒ equipSlot "armour" + armour; useMode "charges" ⇒ charges; every useMode except "passive" ⇒ onUse; passive items have no onUse, and a passive trinket needs equipSlot "trinket" or passiveWhenCarried; stackable items have no charges and no equipSlot; knowledge "vague" or revealOnUse "vague" ⇒ vagueText; knowledge "unknown" ⇒ appearanceGroup that exists in unknownAppearances.
- player.startingItems: equipped only with an equipSlot, at most one per slot; count > 1 only for stackable items. growth.perks must be at least growth.choices.
- models: archetype "humanoid" ⇒ humanoid params; other archetypes need colors or parts.
- area spawn entries: min ≤ max. targeting shape area/cone ⇒ radius ≥ 1. Trigger.every only with on "on_turn".
- custom resources: start ≤ max; ids must not collide with built-in stats.
- goal / lock conditions must be achievable (see BALANCE). gm.fallback.areaEnter: one line per area, in order.
- Keep within the length limits (string≤N); be concise: the whole JSON must fit in one reply. The limits that trip most often: meta.tagline ≤140 (one short sentence), attack verb ≤30 (1–4 words, also in languages with long words), every name ≤40, unknownAppearances labels ≤40, goal.summary ≤200, goal labels ≤60, gm.fallback.intro ≤600, each fallback event ≤200.
- Part.shape is one of the listed shapes only; Part.rot is in degrees.
- gm.fallback.events can play in any area: write them so they fit everywhere.`;

/**
 * A small, valid example of the shape. Deliberately mundane and far from the usual prompts (an
 * abstract-art example nudged an abstract-art request towards copying it), so its content is not reused.
 */
export const WORLD_EXAMPLE = {
  actor: {
    id: 'brass-weathercock',
    name: 'Brass Weathercock',
    description: 'A rooftop weathervane that has worked itself loose and now pecks at anything facing the wrong way.',
    faction: 'hostile',
    stats: { hp: 9, ac: 12, str: 9, dex: 13, int: 3 },
    speed: 110,
    attack: { name: 'Peck', verb: 'pecks', damage: { base: 1, dice: '1d4' }, damageType: 'physical', range: 1, accuracyStat: 'dex' },
    behaviour: { type: 'chaser', erratic: 0.2 },
    loot: [{ item: 'cough-drop', chance: 0.25 }],
    triggers: [{ on: 'on_death', action: { effects: [{ type: 'currency', amount: 3 }] } }],
    xp: 6,
    tags: ['rooftop'],
    model: { archetype: 'flier', colors: { primary: '#b08d3c', secondary: '#5a4a2a' }, idle: 'sway' },
  },
  item: {
    id: 'cough-drop',
    name: 'Menthol Cough Drop',
    kind: 'Lozenge',
    description: 'A sticky green lozenge in waxed paper. It clears the head and steadies the breath.',
    category: 'consumable',
    useMode: 'consumed',
    stackable: true,
    onUse: { targeting: { shape: 'self', affects: 'self_only', range: 0 }, effects: [{ type: 'heal', amount: { base: 5, dice: '1d4' } }], vfx: { kind: 'sparkle', color: '#bff5c8' } },
    value: 12,
    knowledge: 'clear',
    model: { archetype: 'prop', parts: [{ shape: 'sphere', size: [0.2, 0.14, 0.2], color: '#5fcf7a', material: 'glass' }], idle: 'bob' },
  },
} as const;

const EXAMPLE_TEXT = `SHAPE EXAMPLE (one actor and one item, to show the JSON form only; do not reuse its content):
${JSON.stringify(WORLD_EXAMPLE.actor)}
${JSON.stringify(WORLD_EXAMPLE.item)}`;

const SIZE = `SIZE: 8–15 actors (including NPCs and the boss), 15–25 items (including spells, keys, clues), 3–5 areas, 0–10 terrains, 1–3 rules, up to 12 statuses, 7–10 perks. Descriptions: one or two vivid sentences. Compact JSON (no pretty-printing needed).`;

/** the system prompt for world generation (independent of the player's request) */
export function worldSystemPrompt(language = 'en'): string {
  return [
    ROLE,
    CREATIVE,
    languageInstruction(language),
    BUILDING_BLOCKS,
    GENERATORS,
    BALANCE,
    VALIDATION,
    SIZE,
    `WORLD SPEC FORMAT (TypeScript-style description of the JSON you must produce; the root value is a WorldSpec)\n${SCHEMA_NOTATION}\n\n${WORLD_SCHEMA_DOC}`,
    EXAMPLE_TEXT,
    JSON_ONLY,
  ].join('\n\n');
}

/** the user message: the player's request and the run settings */
export function worldUserMessage(opts: WorldPromptOptions): string {
  const language = normaliseLanguage(opts.language);
  const prompt = (opts.prompt ?? '').trim();
  const weird = weirdnessBand(clamp01(opts.weirdness));
  const difficulty = opts.difficulty ?? 'normal';
  const lines: string[] = [];
  if (prompt) {
    lines.push(`The player asked for this world:\n"""\n${prompt.slice(0, 500)}\n"""`);
    lines.push('Honour the request, including any genre, setting, characters or rules it names; invent everything it leaves open.');
  } else {
    const seed = opts.surpriseSeed ?? 1;
    const d = surpriseDraw(seed);
    lines.push('The player chose "Surprise me" and gave no prompt. Build the world from this random draw (treat it as inspiration; you may bend one element if the combination needs it):');
    lines.push(`- genre: ${d.genre}\n- era: ${d.era}\n- tone: ${d.tone}\n- twist: ${d.twist}`);
  }
  lines.push(`Weirdness ${clamp01(opts.weirdness).toFixed(2)} (${weird.label}): ${weird.guidance}`);
  lines.push(`Difficulty: ${difficultyGuidance(difficulty)}`);
  lines.push(`Language: ${languageName(language)} ("${language}"). Set meta.language to "${language}" and meta.prompt to the player's prompt${prompt ? ' verbatim' : ' ("" for surprise)'}.`);
  const recent = (opts.recentWorlds ?? []).map((r) => r.trim()).filter(Boolean).slice(0, 8);
  if (recent.length) {
    lines.push(`The player recently played these worlds; make this one clearly different in genre, setting, tone and structure:\n${recent.map((r) => `- ${r.slice(0, 160)}`).join('\n')}`);
  }
  lines.push('Write the complete World Spec JSON now.');
  return lines.join('\n\n');
}

export function buildWorldPrompt(opts: WorldPromptOptions = {}): BuiltPrompt {
  return { system: worldSystemPrompt(opts.language), user: worldUserMessage(opts) };
}

/** the CompletionRequest the generation pipeline sends (before any repair turns) */
export function worldRequest(opts: WorldPromptOptions = {}, extra: Partial<CompletionRequest> = {}): CompletionRequest {
  const p = buildWorldPrompt(opts);
  return {
    system: p.system,
    messages: [{ role: 'user', content: p.user }],
    schemaName: WORLD_SCHEMA_NAME,
    maxTokens: WORLD_MAX_TOKENS,
    temperature: WORLD_TEMPERATURE,
    purpose: 'world',
    ...extra,
  };
}
