/** Public surface of the overlay UI. Stylesheet: src/client/styles/ui.css (linked from index.html). */
export { createUi, type GameUi, type CreateUiOptions } from './ui';
export type * from './viewmodel';
export { DEFAULT_PALETTE, themeVars, applyTheme, contrast, ensureContrast } from './theme';
export { DEFAULT_VOCABULARY, UNKNOWN_ITEM_TEXT } from './format';
export { resolveKey, keyHelp, attachKeyboard, attachPointer, computeLayer, type UiCommand, type InputLayer, type KeyLike } from './input';
export { activateSlot, slotMenu, moveAction, navigateSlot } from './slots';
export { mountUiDemo, type UiDemo } from './demo';
