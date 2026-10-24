/** Engine-made text outside the log (refusals, built-in dialogue options, NPC roles) via the catalog. */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setLanguage } from '../../src/client/i18n/index';
import { dialogueOptionLabel, engineReason, missLabel, npcRoleLabel, reasonSlug } from '../../src/client/i18n/engine-text';
import en from '../../src/client/i18n/en';
import { NpcSpec } from '../../src/schema/world';

afterEach(() => setLanguage('en', { persist: false }));

const ENGINE = join(__dirname, '../../src/engine');

/** every static refusal reason the engine source contains: invalid('…') and reason: '…' */
function engineReasons(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync(ENGINE).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(ENGINE, f), 'utf8');
    for (const m of src.matchAll(/invalid\('([^']+)'\)/g)) out.add(m[1]!);
  }
  return [...out];
}

describe('engine refusal reasons', () => {
  it('every static reason in the engine has a catalog key', () => {
    const missing = engineReasons().filter((r) => !(`engine.invalid.${reasonSlug(r)}` in en));
    expect(missing).toEqual([]);
  });

  it('render in English and bokmål, world words kept', () => {
    expect(engineReason('blocked')).toBe('Blocked');
    expect(engineReason('Kari has nothing to say')).toBe('Kari has nothing to say');
    setLanguage('nb', { persist: false });
    expect(engineReason('blocked')).toBe('Stengt');
    expect(engineReason('bad direction')).toBe('Ugyldig retning');
    expect(engineReason('the run is over')).toBe('Spillet er over');
    expect(engineReason('not enough gebyrmerker')).toBe('Ikke nok gebyrmerker');
    expect(engineReason('Trehode has nothing to say')).toBe('Trehode har ingenting å si');
    expect(engineReason('Ekkostein: nothing more to find')).toBe('Ekkostein: ikke mer å finne');
    expect(engineReason('Tørrfisk cannot be equipped')).toBe('Tørrfisk kan ikke utstyres');
    // something new from the engine is shown as is rather than lost
    expect(engineReason('a brand new reason')).toBe('A brand new reason');
    expect(engineReason('')).toBe('');
  });
});

describe('dialogue options and roles', () => {
  it('built-in options are translated; world text is left alone', () => {
    setLanguage('nb', { persist: false });
    expect(dialogueOptionLabel({ label: 'Ask what they know' })).toBe('Spør hva de vet');
    expect(dialogueOptionLabel({ label: 'Goodbye' })).toBe('Ha det');
    expect(dialogueOptionLabel({ label: 'Leave' })).toBe('Gå');
    expect(dialogueOptionLabel({ label: 'Ask for help', tag: 'service:heal' })).toBe('Be om hjelp');
    expect(dialogueOptionLabel({ label: 'whatever', tag: 'service:recruit' })).toBe('Be dem bli med');
    expect(dialogueOptionLabel({ label: 'Tørrfisk (4 alen vadmel)', tag: 'buy' })).toBe('Tørrfisk (4 alen vadmel)');
    expect(dialogueOptionLabel({ label: 'Jeg vil høre mer om knutene.' })).toBe('Jeg vil høre mer om knutene.');
  });

  it('every engine dialogue label in src/engine is known', () => {
    const labels = new Set<string>();
    for (const f of ['npc.ts', 'gm.ts']) {
      for (const m of readFileSync(join(ENGINE, f), 'utf8').matchAll(/label: '([^']+)'/g)) labels.add(m[1]!);
    }
    setLanguage('nb', { persist: false });
    const untranslated = [...labels].filter((l) => dialogueOptionLabel({ label: l }) === l);
    expect(untranslated).toEqual([]);
  });

  it('every NPC role has a title in both languages', () => {
    const roles = (NpcSpec.shape.role as unknown as { options: string[] }).options;
    expect(roles.length).toBeGreaterThan(3);
    for (const r of roles) expect(`npc.role.${r}` in en, r).toBe(true);
    expect(npcRoleLabel('quest_giver')).toBe('quest giver');
    setLanguage('nb', { persist: false });
    expect(npcRoleLabel('trader')).toBe('handelsmann');
    expect(npcRoleLabel('quest_giver')).toBe('oppdragsgiver');
    expect(npcRoleLabel('future_role')).toBe('future role');
    expect(missLabel()).toBe('bom');
  });
});

describe('item rarity', () => {
  it('every rarity has a label', async () => {
    const { ItemDef } = await import('../../src/schema/world');
    const rarities = ((ItemDef.shape.rarity as unknown as { _def: { innerType: { options: string[] } } })._def.innerType.options);
    expect(rarities).toContain('unique');
    for (const r of rarities) expect(`item.rarity.${r}` in en, r).toBe(true);
  });
});
