import { describe, expect, it } from 'vitest';
import { DEMO_SCENES, demoSlots, demoViewModel } from '../../src/client/ui/demo-data';
import { TOTAL_SLOTS } from '../../src/client/ui/slots';
import { Vocabulary } from '../../src/schema/world';

describe('demo view models', () => {
  it('produce a complete view model for every scene', () => {
    for (const scene of DEMO_SCENES) {
      const vm = demoViewModel(scene);
      expect(vm.theme.palette.ui).toMatch(/^#/);
      if (vm.screen === 'game') {
        expect(vm.game).toBeDefined();
        expect(vm.game!.slots).toHaveLength(TOTAL_SLOTS);
        expect(vm.game!.hud.stats.map((s) => s.key)).toEqual(['str', 'dex', 'int', 'ac']);
      }
      if (vm.screen === 'start') expect(vm.start).toBeDefined();
      if (vm.screen === 'loading') expect(vm.loading!.steps.length).toBeGreaterThan(0);
      if (vm.screen === 'end') expect(vm.end!.text.length).toBeGreaterThan(0);
    }
  });

  it('scene-specific overlays are set', () => {
    expect(demoViewModel('dialogue').game!.dialogue).not.toBeNull();
    expect(demoViewModel('choice').game!.choice!.options.length).toBeGreaterThanOrEqual(2);
    expect(demoViewModel('levelup').game!.levelUp!.perks.length).toBe(3);
    expect(demoViewModel('trade').game!.trade!.offers.length).toBeGreaterThan(0);
    expect(demoViewModel('narration').game!.narration!.text.length).toBeGreaterThan(10);
    expect(demoViewModel('target').game!.mode).toBe('target');
    expect(demoViewModel('settings').settings!.presets.length).toBeGreaterThan(0);
    expect(demoViewModel('won').end!.result).toBe('won');
  });

  it('demo slots cover every knowledge level and equipment', () => {
    const s = demoSlots().filter(Boolean);
    const k = new Set(s.map((i) => i!.knowledge));
    expect(k).toEqual(new Set(['clear', 'vague', 'unknown']));
    expect(s.some((i) => i!.equipped)).toBe(true);
    expect(s.some((i) => (i!.cooldown ?? 0) > 0)).toBe(true);
    expect(s.some((i) => i!.charges !== undefined)).toBe(true);
    // unknown items never leak exact effects
    for (const i of s) if (i!.knowledge === 'unknown') expect(i!.effectLines).toEqual([]);
  });

  it('demo vocabulary is a valid world vocabulary', () => {
    expect(() => Vocabulary.parse(demoViewModel('game').theme.vocabulary)).not.toThrow();
  });
});
