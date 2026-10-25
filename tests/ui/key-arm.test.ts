/**
 * issues/M5-levelup-accidental-pick.md: a quick-slot digit or Enter pressed right as the level-up
 * card (or a GM offer) opens must not pick an option the player has not read.
 */
import { describe, expect, it } from 'vitest';
import { isKeyboardClick, KeyArm, MODAL_ARM_MS } from '../../src/client/ui/key-arm';
import { resolveKey } from '../../src/client/ui/input';

describe('KeyArm', () => {
  it('is armed before any reset, disarmed right after one, and armed again after the delay', () => {
    let now = 1000;
    const arm = new KeyArm(MODAL_ARM_MS, () => now);
    expect(arm.armed()).toBe(true);
    arm.reset();
    expect(arm.armed()).toBe(false);
    now += MODAL_ARM_MS - 1;
    expect(arm.armed()).toBe(false);
    now += 1;
    expect(arm.armed()).toBe(true);
  });

  it('a new choice (reset) starts the delay again', () => {
    let now = 0;
    const arm = new KeyArm(400, () => now);
    arm.reset();
    now = 450;
    expect(arm.armed()).toBe(true);
    arm.reset();
    now = 500;
    expect(arm.armed()).toBe(false);
  });

  it('the delay is long enough to absorb a quick-slot + Enter rhythm', () => {
    expect(MODAL_ARM_MS).toBeGreaterThanOrEqual(400);
    expect(MODAL_ARM_MS).toBeLessThanOrEqual(600);
  });
});

describe('isKeyboardClick', () => {
  it('detail 0 is a keyboard click, 1+ a pointer click or tap', () => {
    expect(isKeyboardClick({ detail: 0 })).toBe(true);
    expect(isKeyboardClick({ detail: 1 })).toBe(false);
    expect(isKeyboardClick({ detail: 2 })).toBe(false);
    expect(isKeyboardClick(undefined)).toBe(false);
  });
});

describe('level-up / choice layers still map digits to options (the modal decides when they act)', () => {
  const key = (k: string) => ({ key: k, code: /^\d$/.test(k) ? `Digit${k}` : k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }) as KeyboardEvent;
  it('digit → option, Enter → confirm (which neither layer acts on)', () => {
    expect(resolveKey(key('1'), 'levelup', {} as never)).toEqual({ type: 'option', index: 0 });
    expect(resolveKey(key('2'), 'choice', {} as never)).toEqual({ type: 'option', index: 1 });
    expect(resolveKey(key('Enter'), 'levelup', {} as never)).toEqual({ type: 'confirm' });
  });
});
