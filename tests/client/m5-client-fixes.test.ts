/**
 * M5 client fixes (issues/M5-*.md), the DOM-free parts: keyboard zoom direction, the final-stretch
 * goal step, conversations that answer in place (ask / healer), item card facts not repeated,
 * onboarding verb keys and the ranged weapon line, short names on context buttons, goal labels as
 * written, worlds in their own language, stored worlds vs. the saved run, untrusted ids.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameState, Pos } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';
import { GameSession } from '../../src/client/session';
import { conflictEntries, contextActions, currentStep, flagSource, goalView, inWorldLanguage, leafText, onboardingView, shortName, stateLabel, stepText, worldTextLanguage } from '../../src/client/guide';
import { worldLanguageLog } from '../../src/client/view';
import { itemMeta } from '../../src/client/ui/components/common';
import { localizedPreset, presetLabel, presetNotes, presetRegion } from '../../src/client/ui/format';
import { loadGeneratedWorlds, loadRun, MAX_GENERATED_WORLDS, saveGeneratedWorld, saveRun, type SavedRun } from '../../src/client/storage';
import { rememberWorld } from '../../src/client/worlds';
import { MAX_WORLD_FILE_BYTES } from '../../src/client/world-file';
import { setLanguage } from '../../src/client/i18n/index';
import { getPreset } from '../../src/llm/presets';
import { legalActions, leadPlayer } from '../../src/engine/index';
import type { SlotItemView } from '../../src/client/ui/viewmodel';
import { loadFixture, roomMap } from '../engine/helpers';

const teen = loadFixture('fixture-teen.json');
const western = loadFixture('fixture-western.json');
const ship = loadFixture('fixture-ship.json');

afterEach(() => setLanguage('en', { persist: false }));

function session(world: WorldSpec, seed = 3): GameSession {
  const s = new GameSession({ world, worldId: `fixture-${world.meta.title}`, seed, map: roomMap(14, 10) });
  s.narration = null;
  return s;
}

/** only the player and one NPC (from any area of the world), side by side */
function withNpc(s: GameSession, defId: string, me: Pos = { x: 5, y: 5 }, them: Pos = { x: 6, y: 5 }): string {
  const st = structuredClone(s.state) as GameState;
  const pl = st.area.actors.find((a) => a.id === leadPlayer(st).actorId)!;
  pl.pos = { ...me };
  const template = st.area.actors.find((a) => a.id !== pl.id) ?? pl;
  const def = s.world.actors.find((d) => d.id === defId)!;
  const npc = { ...structuredClone(template), id: `npc-${defId}`, defId, pos: { ...them }, hp: def.stats.hp, faction: 'friendly' as const, talkedTo: false, npcUsed: [] as string[] };
  delete (npc as { allyOf?: string }).allyOf;
  st.area.actors = [pl, npc];
  s.state = st;
  return npc.id;
}

describe('keyboard zoom: "+" brings the camera closer (issues/M5-zoom-keys-inverted.md)', () => {
  it('the zoom intent flips into the renderer contract (delta > 0 zooms out)', () => {
    const s = session(western);
    expect(s.intent({ type: 'zoom', delta: 1 }).camera?.zoom).toBe(-1);
    expect(s.intent({ type: 'zoom', delta: -1 }).camera?.zoom).toBe(1);
  });
});

describe('final-stretch goal step (issues/M5-final-step-opaque-flag.md)', () => {
  it('Lowmoor day 3 with the notebook: "leave Mags speechless", never the opaque flag', () => {
    const s = session(teen);
    const st = structuredClone(s.state) as GameState;
    st.area.index = 2;
    leadPlayer(st).slots[9] = { id: 'test-notebook', defId: 'speech-notebook', count: 1 };
    s.state = st;
    const step = currentStep(teen, s.state);
    expect(step.kind).toBe('final');
    expect(step.text).not.toMatch(/farewell speech is given/i);
    expect(step.text).toMatch(/Mags/);
  });

  it('once Mags is speechless, the step is to use the notebook', () => {
    const s = session(teen);
    const st = structuredClone(s.state) as GameState;
    st.area.index = 2;
    st.defeated['mags-calloway'] = 1;
    s.state = st;
    // no notebook: get it first
    expect(currentStep(teen, s.state).text).toMatch(/Junie's Speech Notebook/);
    const st2 = structuredClone(s.state) as GameState;
    leadPlayer(st2).slots[9] = { id: 'test-notebook', defId: 'speech-notebook', count: 1 };
    s.state = st2;
    // the "all" branch is met now (the engine ends the run as won): nothing left but the summary
    expect(currentStep(teen, s.state).text).toBe(teen.goal.summary);
    // a world whose only way to win is the flag: the step is to use the notebook
    const flagOnly = { ...teen, goal: { ...teen.goal, win: { type: 'flag', flag: 'speech-delivered' } } } as WorldSpec;
    expect(currentStep(flagOnly, s.state).text).toBe("Use Junie's Speech Notebook");
  });

  it('finds the item whose use sets a flag', () => {
    expect(flagSource(teen, 'speech-delivered')).toMatchObject({ kind: 'item', id: 'speech-notebook' });
    expect(flagSource(teen, 'no-such-flag')).toBeNull();
  });
});

describe('conversations answer in place', () => {
  it('"Ask what they know" keeps the dialogue open with the answer as the NPC line, then goes once heard out (issues/M5-dialogue-answers-close.md)', () => {
    const s = session(western);
    const id = withNpc(s, 'kid-tobias');
    s.uiAction({ type: 'talk', targetId: id });
    let d = s.viewModel().game!.dialogue!;
    expect(d).toBeTruthy();
    const lines = western.actors.find((a) => a.id === 'kid-tobias')!.npc!.lines;
    const heard = new Set<string>();
    for (let round = 0; round < 40; round++) {
      d = s.viewModel().game!.dialogue!;
      const ask = d.options.findIndex((o) => /what they know/i.test(o));
      if (ask < 0) break;
      const logBefore = s.state.log.length;
      s.dialogueReply(ask);
      d = s.viewModel().game!.dialogue!;
      expect(d, 'the conversation stays open').toBeTruthy();
      expect(lines).toContain(d.reply);
      heard.add(d.reply);
      // the answer is logged once; the reopen does not log a second line
      expect(s.state.log.length - logBefore).toBe(1);
      expect(s.state.log[s.state.log.length - 1].text).toBe(d.reply);
      expect(d.history?.some((h) => h.who === 'player' && /what they know/i.test(h.text))).toBe(true);
    }
    // everything the NPC knows has been told: the option is gone, the conversation can still be left
    expect(heard.size).toBe(lines.length);
    d = s.viewModel().game!.dialogue!;
    expect(d.options.some((o) => /what they know/i.test(o))).toBe(false);
    s.dialogueLeave();
    expect(s.viewModel().game!.dialogue).toBeNull();
  });

  it('a healer\'s "Ask for help" says what it did, in the dialogue and the log (issues/M5-healer-silent.md)', () => {
    const s = session(western);
    const id = withNpc(s, 'preacher-weekes');
    const st = structuredClone(s.state) as GameState;
    const pl = st.area.actors.find((a) => a.id === leadPlayer(st).actorId)!;
    pl.hp = Math.max(1, Math.floor(pl.hp / 3));
    s.state = st;
    const hpBefore = s.player().hp;
    s.uiAction({ type: 'talk', targetId: id });
    const d0 = s.viewModel().game!.dialogue!;
    const help = d0.options.findIndex((o) => /ask for help/i.test(o));
    expect(help).toBeGreaterThanOrEqual(0);
    s.dialogueReply(help);
    const gained = s.player().hp - hpBefore;
    expect(gained).toBeGreaterThan(0);
    const d = s.viewModel().game!.dialogue!;
    expect(d, 'the conversation stays open').toBeTruthy();
    const hp = western.vocabulary.stats.hp.name;
    expect(d.reply).toBe(`Preacher Hollis Weekes helps you: +${gained} ${hp}.`);
    const last = s.state.log[s.state.log.length - 1];
    expect(last).toMatchObject({ key: 'dlg.healed', kind: 'good', params: { amount: gained } });
    // the service is used up: no second "Ask for help"
    expect(d.options.some((o) => /ask for help/i.test(o))).toBe(false);
  });
});

describe('item card facts (issues/M5-tooltip-duplicate-tags.md)', () => {
  const base: SlotItemView = {
    name: 'Hazel Dowsing Rod',
    kind: 'Rod',
    description: '',
    knowledge: 'clear',
    effectLines: ['Reveals the map', 'Cooldown 15 turns'],
    notes: [],
    count: 1,
    equipped: false,
    usable: true,
    color: '#888888',
    instanceId: 'i1',
    defId: 'rod',
    stackable: false,
    maxCooldown: 15,
  };
  it('a known item does not repeat its cooldown, charges or wear under the bullets', () => {
    expect(itemMeta(base)).toEqual([]);
    expect(itemMeta({ ...base, charges: 2, maxCharges: 3, effectLines: ['Heals 5', 'Charges: 2/3'] })).toEqual([]);
  });
  it('what the bullets never say still shows: ready in N, the stack, equipped', () => {
    expect(itemMeta({ ...base, cooldown: 4 })).toEqual(['ready in 4 turns']);
    expect(itemMeta({ ...base, count: 3, equipped: true })).toEqual(['×3', 'equipped']);
  });
  it('an item without known effects keeps the facts line', () => {
    expect(itemMeta({ ...base, knowledge: 'vague', effectLines: [] })).toEqual(['cooldown 15']);
  });
});

describe('onboarding: verbs with their keys, and a weapon with reach (issues/M5-onboarding-verb-keys.md)', () => {
  it('each verb line carries its key', () => {
    const e = conflictEntries(teen);
    const keyed = e.filter((x) => x.key).map((x) => x.key);
    if (teen.verbs.persuade) expect(keyed).toContain('p');
    if (teen.verbs.talk) expect(keyed).toContain('t');
    if (teen.verbs.sneak) expect(keyed).toContain('c');
    if (teen.verbs.search) expect(keyed).toContain('f');
    const v = onboardingView(teen, 'fixture-teen');
    expect(v.conflictKeys).toHaveLength(v.conflict.length);
  });

  it('the western gunslinger hears that the Peacemaker shoots from afar', () => {
    const s = session(western);
    const lines = conflictEntries(western, s.state).map((x) => x.text);
    const ranged = lines.find((l) => /reaches/.test(l));
    expect(ranged, lines.join('\n')).toBeTruthy();
    expect(ranged).toMatch(/Peacemaker/);
    expect(ranged).toMatch(/5 tiles/);
    // a melee-only start has no such line
    const t = session(teen);
    expect(conflictEntries(teen, t.state).some((x) => /reaches/.test(x.text))).toBe(false);
  });
});

describe('context buttons use short names (issues/M5-phone-talk-pushes-wait.md)', () => {
  it('drops the title after a comma, dash or parenthesis', () => {
    expect(shortName('Hedda Imboden, Head Housekeeper')).toBe('Hedda Imboden');
    expect(shortName('Absalom Vane, the Rain Broker')).toBe('Absalom Vane');
    expect(shortName('Navigator Amsel (Dreaming)')).toBe('Navigator Amsel');
    expect(shortName("Magdalena 'Mags' Calloway")).toBe("Magdalena 'Mags' Calloway");
    expect(shortName('Jean-Luc Picard')).toBe('Jean-Luc Picard');
  });

  it('"Talk to Tobias Ruiz-Hale" without ", Age Eleven"', () => {
    const s = session(western);
    withNpc(s, 'kid-tobias');
    const acts = contextActions(western, s.state, { legal: legalActions(s.state), canTransition: false });
    const talk = acts.find((a) => a.id === 'talk');
    expect(talk?.label).toBe('Talk to Tobias Ruiz-Hale');
    expect(acts[acts.length - 1].id).toBe('wait');
  });
});

describe('goal labels are shown as written (issues/M5-goal-flag-label-double-wrapped.md)', () => {
  it('a labelled flag is its label; a bare flag id keeps the wrapper', () => {
    expect(leafText(teen, undefined, { type: 'flag', flag: 'speech-delivered' })).toBe('The farewell speech is given');
    expect(leafText(teen, undefined, { type: 'flag', flag: 'speech-delivered', value: false })).toBe('Not: The farewell speech is given');
    expect(leafText(teen, undefined, { type: 'flag', flag: 'bell-rung' })).toBe('“bell rung” has happened');
    expect(stepText(teen, undefined, { type: 'flag', flag: 'speech-delivered' })).toBe('Make this happen: The farewell speech is given');
  });

  it('Norwegian: no «…» har skjedd around a sentence', () => {
    setLanguage('nb', { persist: false });
    const nbTeen = { ...teen, meta: { ...teen.meta, language: 'nb' } } as WorldSpec;
    expect(leafText(nbTeen, undefined, { type: 'flag', flag: 'speech-delivered' })).toBe('The farewell speech is given');
    expect(leafText(nbTeen, undefined, { type: 'flag', flag: 'bell-rung' })).toBe('«bell rung» har skjedd');
  });
});

describe('a world in another language than the UI (issues/M5-mixed-language-world-ui.md)', () => {
  it('English world, Norwegian UI: goal lines and engine log lines read in English', () => {
    setLanguage('nb', { persist: false });
    expect(worldTextLanguage(western)).toBe('en');
    const s = session(western);
    const g = inWorldLanguage(western, () => goalView(western, s.state));
    expect(g.lose[0].text).not.toMatch(/går tom|Du /);
    const hp = western.vocabulary.stats.hp.name;
    const log = worldLanguageLog(
      [
        { turn: 1, text: `Mesa Rattler is ${western.vocabulary.defeated}.`, kind: 'combat', key: 'log.defeated', params: { actor: 'Mesa Rattler', defeated: western.vocabulary.defeated } },
        { turn: 1, text: 'Howdy.', kind: 'npc', speaker: 'Tobias' },
      ],
      western,
    );
    expect(log[0].key).toBeUndefined();
    expect(log[0].text).not.toMatch(/ er /);
    expect(log[1].text).toBe('Howdy.');
    void hp;
  });

  it('same language: nothing changes', () => {
    expect(worldTextLanguage(western)).toBeNull();
    const log = [{ turn: 1, text: 'x', kind: 'info' as const, key: 'log.defeated', params: {} }];
    expect(worldLanguageLog(log, western)).toBe(log);
  });
});

describe('settings presets in the UI language (issues/M5-settings-presets-english.md)', () => {
  it('regions, "(local)" and "Custom" are translated; technical notes only in English', () => {
    setLanguage('nb', { persist: false });
    expect(presetRegion('China')).toBe('Kina');
    expect(presetRegion('US')).toBe('USA');
    expect(presetRegion('Mars')).toBe('Mars');
    expect(presetLabel({ id: 'ollama', label: 'Ollama (local)' })).toBe('Ollama (lokal)');
    expect(presetLabel({ id: 'custom', label: 'Custom (OpenAI-compatible)' })).toBe('Egendefinert (OpenAI-kompatibel)');
    expect(presetLabel({ id: 'deepseek', label: 'DeepSeek' })).toBe('DeepSeek');
    const anthropic = getPreset('anthropic')!;
    const notes = presetNotes(localizedPreset(anthropic), 'direct').map((n) => n.text);
    expect(notes.join(' ')).not.toMatch(/Default provider|header/);
    expect(notes[0]).toContain('USA');
  });

  it('the English UI keeps the preset note', () => {
    const anthropic = getPreset('anthropic')!;
    if (!anthropic.notes) return;
    expect(presetNotes(localizedPreset(anthropic), 'direct').map((n) => n.text)).toContain(anthropic.notes);
  });
});

describe('untrusted ids: goal labels and counters (issues/M5-goal-label-prototype-key.md)', () => {
  it('"constructor" is a plain id', () => {
    const w = { ...ship, goal: { ...ship.goal, labels: { 'hull-sealed': 'The hull is sealed' } } } as WorldSpec;
    expect(stateLabel(w, 'constructor')).toBe('constructor');
    expect(stateLabel(w, 'hull-sealed')).toBe('The hull is sealed');
    const s = session(ship);
    expect(stepText(w, s.state, { type: 'counter', counter: 'constructor', cmp: 'gte', value: 2 })).toMatch(/now 0\)$/);
    expect(leafText(w, s.state, { type: 'flag', flag: 'toString' })).toBe('“toString” has happened');
  });
});

class MemoryStorage {
  private m = new Map<string, string>();
  quota = Infinity;
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    let size = String(v).length;
    for (const [kk, vv] of this.m) if (kk !== k) size += vv.length;
    if (size > this.quota) throw new Error('QuotaExceededError');
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

describe('stored worlds vs. the autosaved run (issues/M5-stored-world-evicts-saved-run.md)', () => {
  const g = globalThis as { localStorage?: unknown };
  let prev: unknown;
  let mem: MemoryStorage;
  beforeEach(() => {
    prev = g.localStorage;
    mem = new MemoryStorage();
    g.localStorage = mem;
  });
  afterEach(() => {
    g.localStorage = prev;
  });
  const run = (worldId: string): SavedRun => ({ v: 1, worldId, worldTitle: 'W', playerName: 'p', areaName: 'a', turn: 3, state: '{}', gmLog: [], savedAt: 2 });

  it('the cap never evicts the world the saved run is played in', () => {
    const world = { meta: { title: 'W' } };
    expect(saveGeneratedWorld('gen-playing-1', world, 1, { source: 'generated' })).toBe(true);
    expect(saveRun(run('gen-playing-1'))).toBe(true);
    for (let i = 0; i < MAX_GENERATED_WORLDS + 2; i++) expect(saveGeneratedWorld(`gen-imported-${i}`, world, 10 + i, { source: 'imported' })).toBe(true);
    expect(loadRun()?.worldId).toBe('gen-playing-1');
    const ids = loadGeneratedWorlds().map((w) => w.id);
    expect(ids).toContain('gen-playing-1');
    expect(ids).toHaveLength(MAX_GENERATED_WORLDS);
    expect(ids).toContain(`gen-imported-${MAX_GENERATED_WORLDS + 1}`);
  });

  it('a full storage drops other worlds, never the run\'s; a world that cannot fit is refused', () => {
    const big = (n: number) => ({ meta: { title: 'W' }, pad: 'x'.repeat(n) });
    expect(saveGeneratedWorld('gen-playing', big(3000), 1)).toBe(true);
    expect(saveRun(run('gen-playing'))).toBe(true);
    expect(saveGeneratedWorld('gen-a', big(3000), 2)).toBe(true);
    mem.quota = 9000 + JSON.stringify(run('gen-playing')).length;
    // fits only once gen-a goes
    expect(saveGeneratedWorld('gen-b', big(3000), 3)).toBe(true);
    expect(loadGeneratedWorlds().map((w) => w.id)).toEqual(['gen-playing', 'gen-b']);
    // even alone with the run's world it does not fit: refused, nothing changes
    expect(saveGeneratedWorld('gen-huge', big(8000), 4)).toBe(false);
    expect(loadGeneratedWorlds().map((w) => w.id)).toEqual(['gen-playing', 'gen-b']);
  });

  it('rememberWorld reports whether the world was kept', () => {
    mem.quota = 10;
    expect(rememberWorld(teen, 1, { source: 'imported' }).stored).toBe(false);
  });

  it('a world file is capped far below the storage quota', () => {
    expect(MAX_WORLD_FILE_BYTES).toBeLessThanOrEqual(600_000);
  });
});
