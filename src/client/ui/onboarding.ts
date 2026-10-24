/**
 * Input modes and the few most important controls for each (onboarding card). Pure, no DOM.
 */
import type { Vocabulary } from '../../schema/world';
import { t } from '../i18n/index';

/**
 * How the player is playing right now: 'keyboard' once a key has been pressed, 'touch' after a
 * touch, 'mouse' for a fine pointer without keys yet. Key hints are only shown in 'keyboard'.
 */
export type InputMode = 'keyboard' | 'mouse' | 'touch';

/** the starting mode for a device: touch for coarse pointers (phones, tablets), else mouse */
export function initialInputMode(coarsePointer: boolean): InputMode {
  return coarsePointer ? 'touch' : 'mouse';
}

/** the next mode after an input event; mouse movement never overrides an active keyboard */
export function nextInputMode(current: InputMode, event: 'key' | 'touch' | 'mouse'): InputMode {
  if (event === 'key') return 'keyboard';
  if (event === 'touch') return 'touch';
  return current === 'touch' ? 'mouse' : current;
}

export interface ControlLine {
  /** what to press / do ("↑ ↓ ← →", "Tap a tile") */
  how: string;
  what: string;
  /** shown as a key cap */
  key?: boolean;
}

/** the 5 most important controls for an input mode, with the world's words */
export function onboardingControls(mode: InputMode, vocab: Pick<Vocabulary, 'conflict'>, transitionName?: string): ControlLine[] {
  const conflict = vocab.conflict;
  const way = transitionName ?? t('help.takeExit');
  if (mode === 'touch') {
    return [
      { how: t('onboard.touch.tapTile'), what: t('onboard.touch.tapTileWhat') },
      { how: t('onboard.touch.tapNext'), what: t('onboard.touch.tapNextWhat', { conflict }) },
      { how: t('onboard.touch.buttons'), what: t('onboard.touch.buttonsWhat') },
      { how: t('onboard.touch.slot'), what: t('onboard.touch.slotWhat') },
      { how: t('onboard.touch.goal'), what: t('onboard.touch.goalWhat') },
    ];
  }
  if (mode === 'mouse') {
    return [
      { how: t('onboard.mouse.click'), what: t('onboard.touch.tapTileWhat') },
      { how: t('onboard.mouse.clickNext'), what: t('onboard.touch.tapNextWhat', { conflict }) },
      { how: '↑ ↓ ← → · W A S D', what: t('onboard.key.moveWhat', { conflict }), key: true },
      { how: '1 – 8', what: t('onboard.key.slotsWhat'), key: true },
      { how: '?', what: t('onboard.key.helpWhat'), key: true },
    ];
  }
  return [
    { how: '↑ ↓ ← → · W A S D', what: t('onboard.key.moveWhat', { conflict }), key: true },
    { how: '1 – 8', what: t('onboard.key.slotsWhat'), key: true },
    { how: 'g', what: t('onboard.key.pickupWhat'), key: true },
    { how: '>', what: way, key: true },
    { how: '?', what: t('onboard.key.helpWhat'), key: true },
  ];
}
