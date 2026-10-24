/**
 * M4 integration: engine-made English goes through the catalog, and the start screen shows the
 * prompt library and demo worlds in the UI language.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { demoWorldsFor, localizedInspiration, promptLibrary } from '../../src/client/prompts';
import { setLanguage, registerCatalog } from '../../src/client/i18n/index';
import nb from '../../src/client/i18n/nb';
import { dialogueOptionLabel, engineReason, npcRoleLabel } from '../../src/client/i18n/engine-text';
import { slotLegend } from '../../src/client/ui/input';

registerCatalog('nb', nb, 'Norsk bokmål');

afterEach(() => setLanguage('en', { persist: false }));

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('start screen in the UI language', () => {
  const worlds = [
    { id: 'viking-lawspeaker-althing' },
    { id: 'viking-lawspeaker-althing-nb' },
    { id: 'corporate-merger-kitchen' },
    { id: 'corporate-merger-kitchen-nb' },
    { id: 'fixture-ship' },
  ];

  it('lists the original of a translated world in English and the copy in bokmål, never both', () => {
    expect(ids(demoWorldsFor(worlds, promptLibrary(), 'en'))).toEqual(['viking-lawspeaker-althing', 'corporate-merger-kitchen', 'fixture-ship']);
    expect(ids(demoWorldsFor(worlds, promptLibrary(), 'nb-NO'))).toEqual(['viking-lawspeaker-althing-nb', 'corporate-merger-kitchen-nb', 'fixture-ship']);
  });

  it('keeps a world whose partner is not bundled', () => {
    expect(ids(demoWorldsFor([{ id: 'viking-lawspeaker-althing' }], promptLibrary(), 'nb'))).toEqual(['viking-lawspeaker-althing']);
  });

  it('shows one inspiration card per translation group, in bokmål when translated', () => {
    const lib = promptLibrary();
    const bundled = new Set(worlds.map((w) => w.id));
    const en = localizedInspiration(lib, bundled, 'en');
    const no = localizedInspiration(lib, bundled, 'nb');
    expect(no.length).toBe(en.length);
    const viking = no.find((p) => p.worldId?.startsWith('viking-lawspeaker-althing'));
    expect(viking?.worldId).toBe('viking-lawspeaker-althing-nb');
    expect(viking?.language).toBe('nb');
    expect(no.every((p) => p.language === 'nb')).toBe(true);
    expect(en.filter((p) => p.worldId === 'viking-lawspeaker-althing-nb')).toHaveLength(0);
  });
});

describe('engine text in the UI language', () => {
  it('translates refusal reasons, built-in dialogue options and NPC roles', () => {
    setLanguage('nb', { persist: false });
    expect(engineReason('blocked')).not.toMatch(/blocked/i);
    expect(dialogueOptionLabel({ label: 'Goodbye' })).not.toBe('Goodbye');
    expect(dialogueOptionLabel({ label: 'Leave' })).not.toBe('Leave');
    expect(npcRoleLabel('quest_giver')).not.toMatch(/quest/);
    expect(slotLegend()[0]).toMatchObject({ mark: 'U', equipped: true });
  });

  it('keeps world-written option labels untouched', () => {
    setLanguage('nb', { persist: false });
    expect(dialogueOptionLabel({ label: 'Saltfisk (3 skilling)', tag: 'buy' })).toBe('Saltfisk (3 skilling)');
  });

  it('English stays English', () => {
    expect(slotLegend()[0]).toMatchObject({ mark: 'E', equipped: true });
    expect(dialogueOptionLabel({ label: 'Goodbye' })).toBe('Goodbye');
  });
});

describe('offline demo loading screen', () => {
  it('does not claim to ask an AI', async () => {
    const { WorldGeneration } = await import('../../src/client/ai');
    const { MockProvider } = await import('../../src/llm/mock');
    const p = new MockProvider({ fallback: () => '{}' });
    const req = { prompt: 'x', surprise: false, difficulty: 'normal', weirdness: 1, language: 'en' } as unknown as ConstructorParameters<typeof WorldGeneration>[1];
    const offline = new WorldGeneration(p, req, { offline: true });
    offline.progress({ stage: 'request', key: 'gen.progress.request', message: 'Asking the AI to invent the world' } as never);
    expect(offline.view().steps[0]!.label).toMatch(/recorded world/);
    const online = new WorldGeneration(p, req);
    online.progress({ stage: 'request', key: 'gen.progress.request', message: 'Asking the AI to invent the world' } as never);
    expect(online.view().steps[0]!.label).toMatch(/AI/);
  });
});

describe('GM / dialogue prompts read engine log lines in the world language', () => {
  it('renders keyed engine lines in bokmål for an nb world, leaves GM lines and English worlds alone', async () => {
    const { promptLog, withPromptLog } = await import('../../src/client/i18n/prompt-log');
    const { loadFixture } = await import('../engine/helpers');
    const en = loadFixture('fixture-western.json');
    const nbWorld = { ...en, meta: { ...en.meta, language: 'nb' } };
    const log = [
      { turn: 3, kind: 'loot', text: 'You pick up Rope.', key: 'log.pickup', params: { item: 'Rope' } },
      { turn: 3, kind: 'gm', text: 'The wind turns.' },
    ] as never[];
    setLanguage('en', { persist: false });
    const out = promptLog(log, nbWorld);
    expect(out[1]).toBe(log[1]);
    expect(promptLog(log, en)).toBe(log);
    const state = { log } as never;
    expect(withPromptLog(state, en)).toBe(state);
    const nbKey = Object.keys(nb).find((k) => k.startsWith('log.')) as string;
    expect(nbKey).toBeTruthy();
    const keyed = promptLog([{ turn: 1, kind: 'system', text: 'english', key: nbKey, params: {} }] as never[], nbWorld);
    expect(keyed[0]!.text).not.toBe('english');
  });
});
