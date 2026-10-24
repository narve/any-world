/**
 * Touch-first controls (PLAN "Clearer controls & goals"): pressing an equipped/passive slot explains
 * it instead of opening the backpack, the onboarding controls follow the input mode, and key hints
 * only appear once a keyboard has been used.
 */
import { describe, expect, it } from 'vitest';
import { activateSlot, slotExplanation } from '../../src/client/ui/slots';
import { initialInputMode, nextInputMode, onboardingControls } from '../../src/client/ui/onboarding';
import { keyCap } from '../../src/client/ui/components/guide';
import { keyHelp, slotLegend } from '../../src/client/ui/input';
import type { SlotItemView } from '../../src/client/ui/viewmodel';

function item(over: Partial<SlotItemView> = {}): SlotItemView {
  return {
    name: 'Dog-eared Thesaurus',
    kind: 'Vocabulary',
    description: '',
    knowledge: 'clear',
    effectLines: [],
    notes: [],
    count: 1,
    equipped: false,
    usable: false,
    color: '#2b3a67',
    instanceId: 'i1',
    defId: 'thesaurus',
    stackable: false,
    ...over,
  };
}

describe('pressing a slot that has nothing to do (the Lowmoor Thesaurus report)', () => {
  it('an equipped weapon is explained with the world words, never opens the backpack', () => {
    const thesaurus = item({ equipped: true, equipSlot: 'weapon' });
    expect(activateSlot([thesaurus], 0)).toEqual({ kind: 'explain' });
    const exp = slotExplanation(thesaurus, { conflict: 'Comeback' });
    expect(exp.title).toBe('Dog-eared Thesaurus');
    expect(exp.lines[0]).toBe('Equipped as your Comeback — bump into anyone hostile (red ring) to use it.');
    expect(exp.lines.join(' ')).toContain('E badge');
  });

  it('armour, other equipment and passive items each get their own line; known effects are listed', () => {
    expect(slotExplanation(item({ equipped: true, equipSlot: 'armour' }), { conflict: 'Attack' }).lines[0]).toMatch(/^Worn/);
    expect(slotExplanation(item({ equipped: true, equipSlot: 'trinket' }), { conflict: 'Attack' }).lines[0]).toMatch(/^Equipped — it works/);
    const charm = slotExplanation(item({ effectLines: ['+1 Nerve'] }), { conflict: 'Attack' });
    expect(charm.lines).toEqual(['Works just by being carried — nothing to press.', '+1 Nerve']);
    const vague = slotExplanation(item({ knowledge: 'vague', vagueText: 'It hums.' }), { conflict: 'Attack' });
    expect(vague.lines[1]).toBe('It hums.');
    const unknown = slotExplanation(item({ knowledge: 'unknown' }), { conflict: 'Attack' });
    expect(unknown.lines[1]).toBe('Unknown — could be anything');
  });

  it('usable and unequipped items still act', () => {
    expect(activateSlot([item({ usable: true })], 0)).toEqual({ kind: 'action', action: { type: 'use', slot: 0 } });
    expect(activateSlot([item({ equipSlot: 'weapon' })], 0)).toEqual({ kind: 'action', action: { type: 'equip', slot: 0 } });
  });
});

describe('input mode', () => {
  it('starts from the device and follows the last input; mouse never hides an active keyboard', () => {
    expect(initialInputMode(true)).toBe('touch');
    expect(initialInputMode(false)).toBe('mouse');
    expect(nextInputMode('mouse', 'key')).toBe('keyboard');
    expect(nextInputMode('keyboard', 'mouse')).toBe('keyboard');
    expect(nextInputMode('keyboard', 'touch')).toBe('touch');
    expect(nextInputMode('touch', 'mouse')).toBe('mouse');
  });

  it('the onboarding lists five controls for the current mode, with the conflict word', () => {
    for (const mode of ['keyboard', 'mouse', 'touch'] as const) {
      const c = onboardingControls(mode, { conflict: 'Comeback' }, 'Walk home');
      expect(c).toHaveLength(5);
      expect(c.map((x) => x.what).join(' ')).toContain('Comeback');
    }
    expect(onboardingControls('touch', { conflict: 'Attack' }).every((c) => !c.key)).toBe(true);
    expect(onboardingControls('keyboard', { conflict: 'Attack' }, 'Walk home').some((c) => c.how === '>' && c.what === 'Walk home')).toBe(true);
  });

  it('key caps read like the keys', () => {
    expect(keyCap('t')).toBe('T');
    expect(keyCap('Enter')).toBe('Enter');
    expect(keyCap('>')).toBe('>');
    expect(keyCap('.')).toBe('.');
  });
});

describe('help', () => {
  it('explains the E badge and the other slot marks', () => {
    const legend = slotLegend();
    expect(legend[0]).toMatchObject({ mark: 'E' });
    expect(legend[0].what).toMatch(/^Equipped/);
    expect(legend.length).toBeGreaterThanOrEqual(5);
  });

  it('has a touch & mouse section that mentions the action buttons and the goal', () => {
    const touch = keyHelp({ talk: true, sneak: false, search: true, persuade: false }, { conflict: 'Attack' }).find((s) => s.title === 'Touch & mouse')!;
    const text = touch.rows.map((r) => `${r.keys.join(' ')} ${r.what}`).join(' | ');
    expect(text).toContain('Action buttons');
    expect(text).toContain('Tap the goal');
    expect(text).toContain('Long-press a slot');
  });
});
