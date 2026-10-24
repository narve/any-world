/**
 * Keyboard input. `resolveKey` is a pure function (KeyLike + layer → UiCommand) so the whole
 * key map is unit-testable; `attachKeyboard` is the thin DOM binding.
 *
 * FINAL KEY MAP (also rendered by the help overlay from KEY_HELP):
 *   Move / bump:   arrows · WASD · vi-keys h j k l y u b n · numpad 1-9 (5 = wait)
 *   Quick slots:   1-8 (top-row digits; numpad digits move)
 *   Pick up:       g  or  ,
 *   Backpack:      i  or  Tab
 *   Look mode:     x            Wait: .  or  Space  (numpad 5)
 *   Transition:    >            Talk: t          Persuade: p (if enabled)
 *   Use next to you: Enter (consoles, pods, wells… also: walk into it or click it)
 *   Search:        f  (s is WASD south, so search lives on f; only if enabled)
 *   Sneak:         c  (only if enabled)
 *   Camera:        q / e rotate · + / - zoom
 *   Rules & goals: r            Help: ?          Close / cancel: Esc
 *  Backpack:  arrows/WASD/hjkl move cursor · Enter/Space actions · 1-8 assign to quick slot ·
 *             u use · e equip/unequip · q to quick slot · b to backpack · m move (then Enter to place) ·
 *             Del/Backspace drop · Esc / i / Tab close
 *  Dialogue / choices / perk cards: 1-3 pick · ↑↓ focus · Enter confirm · Esc leave (dialogue only)
 *  Dialogue only: p persuade (if enabled) · t trade (trader NPCs)
 */
import type { Dir } from '../../engine/types';
import type { Vocabulary } from '../../schema/world';
import { t } from '../i18n/index';

export interface KeyLike {
  key: string;
  code?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}

export type InputLayer =
  | 'none'
  | 'start'
  | 'loading'
  | 'end'
  | 'game'
  | 'narration'
  | 'look'
  | 'target'
  | 'backpack'
  | 'menu'
  | 'dialogue'
  | 'choice'
  | 'levelup'
  | 'trade'
  | 'help'
  | 'rules'
  | 'settings'
  | 'text';

export interface InputVerbs {
  talk: boolean;
  sneak: boolean;
  search: boolean;
  persuade: boolean;
}

export type UiCommand =
  | { type: 'move'; dir: Dir }
  | { type: 'wait' }
  | { type: 'slot'; index: number }
  | { type: 'pickup' }
  | { type: 'backpack' }
  | { type: 'look' }
  | { type: 'transition' }
  | { type: 'talk' }
  | { type: 'persuade' }
  | { type: 'trade' }
  | { type: 'search' }
  | { type: 'sneak' }
  | { type: 'interact' }
  | { type: 'rotate'; dir: -1 | 1 }
  | { type: 'zoom'; delta: -1 | 1 }
  | { type: 'help' }
  | { type: 'rules' }
  | { type: 'close' }
  | { type: 'nav'; dir: Dir }
  | { type: 'confirm' }
  | { type: 'option'; index: number }
  | { type: 'menu_key'; key: 'u' | 'e' | 'q' | 'b' | 'm' | 'Delete' }
  | { type: 'skip' };

const ARROWS: Record<string, Dir> = { ArrowUp: 'n', ArrowDown: 's', ArrowLeft: 'w', ArrowRight: 'e' };
const WASD: Record<string, Dir> = { w: 'n', a: 'w', s: 's', d: 'e' };
const VI: Record<string, Dir> = { h: 'w', j: 's', k: 'n', l: 'e', y: 'nw', u: 'ne', b: 'sw', n: 'se' };
const VI_ORTHO: Record<string, Dir> = { h: 'w', j: 's', k: 'n', l: 'e' };
const NUMPAD: Record<string, Dir> = {
  Numpad8: 'n', Numpad2: 's', Numpad4: 'w', Numpad6: 'e',
  Numpad7: 'nw', Numpad9: 'ne', Numpad1: 'sw', Numpad3: 'se',
};
/** numpad with NumLock off */
const NAV_KEYS: Record<string, Dir> = { Home: 'nw', PageUp: 'ne', End: 'sw', PageDown: 'se' };

function lower(k: string): string {
  return k.length === 1 ? k.toLowerCase() : k;
}

/** a direction from any movement scheme; `full` includes WASD + vi diagonals */
export function directionOf(ev: KeyLike, scheme: 'full' | 'grid' = 'full'): Dir | null {
  if (ev.code && NUMPAD[ev.code]) return NUMPAD[ev.code];
  if (ARROWS[ev.key]) return ARROWS[ev.key];
  if (NAV_KEYS[ev.key] && scheme === 'full') return NAV_KEYS[ev.key];
  if (ev.shiftKey && ev.key.length === 1 && ev.key !== ev.key.toLowerCase()) return null; // capitals reserved
  const k = lower(ev.key);
  if (WASD[k]) return WASD[k];
  if (scheme === 'full' && VI[k]) return VI[k];
  if (scheme === 'grid' && VI_ORTHO[k]) return VI_ORTHO[k];
  return null;
}

function isNumpad(ev: KeyLike): boolean {
  return !!ev.code && ev.code.startsWith('Numpad');
}

/** top-row digit 1..9 → 0-based index, or null */
export function digitIndex(ev: KeyLike): number | null {
  if (isNumpad(ev)) return null;
  if (/^[1-9]$/.test(ev.key)) return Number(ev.key) - 1;
  if (ev.code && /^Digit[1-9]$/.test(ev.code) && !ev.shiftKey) return Number(ev.code.slice(5)) - 1;
  return null;
}

function isWait(ev: KeyLike): boolean {
  return ev.key === '.' || ev.key === ' ' || ev.key === 'Spacebar' || ev.code === 'Numpad5' || ev.key === 'Clear';
}

function isHelp(ev: KeyLike): boolean {
  return ev.key === '?';
}

function isConfirm(ev: KeyLike): boolean {
  return ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar' || ev.code === 'NumpadEnter';
}

/** the map-play key map (layer 'game') */
function gameKey(ev: KeyLike, verbs: InputVerbs): UiCommand | null {
  if (ev.key === 'Tab') return ev.shiftKey ? null : { type: 'backpack' };
  if (isWait(ev)) return { type: 'wait' };
  const di = digitIndex(ev);
  if (di !== null) return di < 8 ? { type: 'slot', index: di } : null;
  const dir = directionOf(ev, 'full');
  if (dir) return { type: 'move', dir };
  if (ev.key === 'Enter' || ev.code === 'NumpadEnter') return { type: 'interact' };
  switch (ev.key) {
    case '>':
      return { type: 'transition' };
    case ',':
      return { type: 'pickup' };
    case '?':
      return { type: 'help' };
    case '+':
    case '=':
      return { type: 'zoom', delta: 1 };
    case '-':
    case '_':
      return { type: 'zoom', delta: -1 };
    case 'Escape':
      return { type: 'close' };
  }
  if (ev.code === 'NumpadAdd') return { type: 'zoom', delta: 1 };
  if (ev.code === 'NumpadSubtract') return { type: 'zoom', delta: -1 };
  switch (lower(ev.key)) {
    case 'g':
      return { type: 'pickup' };
    case 'i':
      return { type: 'backpack' };
    case 'x':
      return { type: 'look' };
    case 't':
      return verbs.talk ? { type: 'talk' } : null;
    case 'p':
      return verbs.persuade ? { type: 'persuade' } : null;
    case 'f':
      return verbs.search ? { type: 'search' } : null;
    case 'c':
      return verbs.sneak ? { type: 'sneak' } : null;
    case 'q':
      return { type: 'rotate', dir: -1 };
    case 'e':
      return { type: 'rotate', dir: 1 };
    case 'r':
      return { type: 'rules' };
  }
  return null;
}

/**
 * Resolve a key press for the current UI layer. Returns null when the key should be left to the
 * browser (text editing, native focus movement, unknown keys).
 */
export function resolveKey(ev: KeyLike, layer: InputLayer, verbs: InputVerbs): UiCommand | null {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  switch (layer) {
    case 'none':
    case 'start':
    case 'loading':
    case 'end':
      return null;
    case 'text':
    case 'settings':
      return ev.key === 'Escape' ? { type: 'close' } : null;
    case 'help':
    case 'rules':
      if (ev.key === 'Escape' || ev.key === 'Enter' || isHelp(ev)) return { type: 'close' };
      if (layer === 'rules' && lower(ev.key) === 'r') return { type: 'close' };
      return null;
    case 'game':
      return gameKey(ev, verbs);
    case 'narration':
      if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') return { type: 'skip' };
      return gameKey(ev, verbs);
    case 'look':
    case 'target': {
      if (ev.key === 'Escape') return { type: 'close' };
      if (layer === 'look' && lower(ev.key) === 'x') return { type: 'close' };
      if (isConfirm(ev)) return { type: 'confirm' };
      const dir = directionOf(ev, 'full');
      if (dir) return { type: 'nav', dir };
      if (layer === 'target') {
        const di = digitIndex(ev);
        if (di !== null && di < 8) return { type: 'slot', index: di };
      }
      if (isHelp(ev)) return { type: 'help' };
      if (ev.key === '+' || ev.key === '=') return { type: 'zoom', delta: 1 };
      if (ev.key === '-' || ev.key === '_') return { type: 'zoom', delta: -1 };
      if (lower(ev.key) === 'q') return { type: 'rotate', dir: -1 };
      if (lower(ev.key) === 'e') return { type: 'rotate', dir: 1 };
      return null;
    }
    case 'backpack': {
      if (ev.key === 'Escape' || ev.key === 'Tab' || lower(ev.key) === 'i') return { type: 'close' };
      if (isConfirm(ev)) return { type: 'confirm' };
      if (ev.key === 'Delete' || ev.key === 'Backspace') return { type: 'menu_key', key: 'Delete' };
      const di = digitIndex(ev);
      if (di !== null) return di < 8 ? { type: 'option', index: di } : null;
      const dir = directionOf(ev, 'grid');
      if (dir) return { type: 'nav', dir };
      const k = lower(ev.key);
      if (k === 'u' || k === 'e' || k === 'q' || k === 'b' || k === 'm') return { type: 'menu_key', key: k };
      if (isHelp(ev)) return { type: 'help' };
      return null;
    }
    case 'menu': {
      if (ev.key === 'Escape') return { type: 'close' };
      if (ev.key === 'Enter' || ev.key === ' ') return { type: 'confirm' };
      if (ev.key === 'Delete' || ev.key === 'Backspace') return { type: 'menu_key', key: 'Delete' };
      const dir = directionOf(ev, 'grid');
      if (dir === 'n' || dir === 's') return { type: 'nav', dir };
      const k = lower(ev.key);
      if (k === 'u' || k === 'e' || k === 'q' || k === 'b' || k === 'm') return { type: 'menu_key', key: k };
      return null;
    }
    case 'dialogue':
    case 'choice':
    case 'levelup':
    case 'trade': {
      if (ev.key === 'Escape') return layer === 'choice' || layer === 'levelup' ? null : { type: 'close' };
      const di = digitIndex(ev);
      if (di !== null) return { type: 'option', index: di };
      if (ev.key === 'Enter') return { type: 'confirm' };
      if (ARROWS[ev.key]) return { type: 'nav', dir: ARROWS[ev.key] };
      if (isHelp(ev)) return { type: 'help' };
      // the conversation footer's buttons (issues/M2-dialogue-persuade-key.md): the panel ignores
      // them when the button is not shown (no trader, persuasion off, NPC still answering)
      if (layer === 'dialogue' && !ev.shiftKey) {
        const k = lower(ev.key);
        if (k === 'p' && verbs.persuade) return { type: 'persuade' };
        if (k === 't') return { type: 'trade' };
      }
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Help content (single source of truth for the documented key map)
// ---------------------------------------------------------------------------

export interface HelpSection {
  title: string;
  rows: { keys: string[]; what: string }[];
}

export function keyHelp(verbs: InputVerbs, vocab: Pick<Vocabulary, 'conflict'>, transitionName = t('help.takeExit')): HelpSection[] {
  const play: HelpSection = {
    title: t('help.section.play'),
    rows: [
      { keys: ['↑ ↓ ← →', 'W A S D', 'h j k l y u b n', t('key.numpad')], what: t('help.move', { conflict: vocab.conflict.toLowerCase() }) },
      { keys: ['.', t('key.space'), t('key.numpad5')], what: t('help.wait') },
      { keys: ['1 – 8'], what: t('help.slot') },
      { keys: ['g', ','], what: t('help.pickup') },
      { keys: ['>'], what: transitionName },
      { keys: [t('key.enter')], what: t('help.interact') },
      { keys: ['x'], what: t('help.look') },
    ],
  };
  if (verbs.talk) play.rows.push({ keys: ['t'], what: t('help.talk') });
  if (verbs.persuade) play.rows.push({ keys: ['p'], what: t('help.persuade') });
  if (verbs.search) play.rows.push({ keys: ['f'], what: t('help.search') });
  if (verbs.sneak) play.rows.push({ keys: ['c'], what: t('help.sneak') });
  return [
    play,
    {
      title: t('help.section.panels'),
      rows: [
        { keys: ['i', t('key.tab')], what: t('help.backpack') },
        { keys: ['r'], what: t('help.rules') },
        { keys: ['q', 'e'], what: t('help.rotate') },
        { keys: ['+', '-'], what: t('help.zoom') },
        { keys: ['?'], what: t('help.help') },
        { keys: [t('key.esc')], what: t('help.close') },
      ],
    },
    {
      title: t('help.section.backpack'),
      rows: [
        { keys: [t('key.arrows'), 'WASD', 'hjkl'], what: t('help.bp.cursor') },
        { keys: [t('key.enter')], what: t('help.bp.actions') },
        { keys: ['1 – 8'], what: t('help.bp.assign') },
        { keys: ['u'], what: t('help.bp.use') },
        { keys: ['e'], what: t('help.bp.equip') },
        { keys: ['m'], what: t('help.bp.move') },
        { keys: [t('key.del')], what: t('help.bp.drop') },
        { keys: [t('key.drag')], what: t('help.bp.drag') },
      ],
    },
    {
      title: t('help.section.touch'),
      rows: [
        { keys: [t('key.tapTile'), t('key.clickTile')], what: t('help.touch.travel') },
        { keys: [t('key.tapNext')], what: t('help.touch.act') },
        { keys: [t('key.ctxButtons')], what: t('help.touch.ctx') },
        { keys: [t('key.tapGoal')], what: t('help.touch.goal') },
        { keys: [t('key.hover')], what: t('help.mouse.hover') },
        { keys: [t('key.longPressSlot'), t('key.rightClickSlot')], what: t('help.mouse.slotMenu') },
      ],
    },
  ];
}

/** the hotbar badges and marks, explained (help overlay legend) */
export function slotLegend(): { mark: string; what: string }[] {
  return [
    { mark: 'E', what: t('legend.equipped') },
    { mark: '1', what: t('legend.key') },
    { mark: '×3', what: t('legend.stack') },
    { mark: '2/3', what: t('legend.charges') },
    { mark: '◔', what: t('legend.cooldown') },
    { mark: t('legend.pressMark'), what: t('legend.urgent') },
  ];
}

// ---------------------------------------------------------------------------
// DOM binding
// ---------------------------------------------------------------------------

export function isTextTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color'].includes(type);
  }
  return !!el.isContentEditable;
}

export interface KeyboardBinding {
  detach(): void;
}

/**
 * Listen for keydown on `target` (default window). `getLayer` is consulted per key; text inputs
 * automatically use the 'text' layer. When a command is produced the event's default is
 * prevented and `onCommand` is called.
 */
export function attachKeyboard(
  getLayer: () => InputLayer,
  getVerbs: () => InputVerbs,
  onCommand: (cmd: UiCommand, ev: KeyboardEvent) => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): KeyboardBinding {
  const handler = (e: Event) => {
    const ev = e as KeyboardEvent;
    if (ev.defaultPrevented) return;
    let layer = getLayer();
    if (isTextTarget(ev.target) && layer !== 'none') layer = 'text';
    const cmd = resolveKey(ev, layer, getVerbs());
    if (!cmd) return;
    // let Enter/Space activate a focused button natively in dialogs/menus
    const tgt = ev.target as HTMLElement | null;
    const onButton = !!tgt && typeof tgt.tagName === 'string' && tgt.tagName === 'BUTTON';
    if (onButton && cmd.type === 'confirm' && (layer === 'dialogue' || layer === 'choice' || layer === 'levelup' || layer === 'trade' || layer === 'menu')) return;
    ev.preventDefault();
    onCommand(cmd, ev);
  };
  target.addEventListener('keydown', handler);
  return { detach: () => target.removeEventListener('keydown', handler) };
}

// ---------------------------------------------------------------------------
// Pointer binding for the map (the renderer supplies tile picking)
// ---------------------------------------------------------------------------

export interface TilePos {
  x: number;
  y: number;
}

export function sameTile(a: TilePos | null, b: TilePos | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y;
}

/**
 * Turn raw mouse events on the canvas container into tile intents. `pickTile` maps client
 * coordinates to a tile (renderer raycast) or null. Hover intents are only emitted when the
 * hovered tile changes; clicks that were really camera drags (moved > 6px) are ignored.
 */
export function attachPointer(
  el: HTMLElement,
  pickTile: (clientX: number, clientY: number) => TilePos | null,
  emit: (intent: { type: 'click_tile'; pos: TilePos; button: 'primary' | 'secondary' } | { type: 'hover_tile'; pos: TilePos | null }) => void,
): KeyboardBinding {
  let hovered: TilePos | null = null;
  let downAt: { x: number; y: number } | null = null;
  const onMove = (e: MouseEvent) => {
    const t = pickTile(e.clientX, e.clientY);
    if (!sameTile(t, hovered)) {
      hovered = t;
      emit({ type: 'hover_tile', pos: t });
    }
  };
  const onLeave = () => {
    if (hovered) {
      hovered = null;
      emit({ type: 'hover_tile', pos: null });
    }
  };
  const onDown = (e: MouseEvent) => {
    downAt = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: MouseEvent) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 6 || (e.button !== 0 && e.button !== 2)) return;
    const t = pickTile(e.clientX, e.clientY);
    if (t) emit({ type: 'click_tile', pos: t, button: e.button === 2 ? 'secondary' : 'primary' });
  };
  const onContext = (e: Event) => e.preventDefault();
  el.addEventListener('mousemove', onMove);
  el.addEventListener('mouseleave', onLeave);
  el.addEventListener('mousedown', onDown);
  el.addEventListener('mouseup', onUp);
  el.addEventListener('contextmenu', onContext);
  return {
    detach() {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('mouseup', onUp);
      el.removeEventListener('contextmenu', onContext);
    },
  };
}

// ---------------------------------------------------------------------------
// Layer priority (pure)
// ---------------------------------------------------------------------------

export interface LayerState {
  screen: 'start' | 'loading' | 'game' | 'end';
  settingsOpen: boolean;
  helpOpen: boolean;
  rulesOpen: boolean;
  backpackOpen: boolean;
  menuOpen: boolean;
  narrationVisible: boolean;
  choice: boolean;
  levelUp: boolean;
  dialogue: boolean;
  trade: boolean;
  mode: 'normal' | 'look' | 'target';
}

/** which input layer receives keys, highest priority first */
export function computeLayer(s: LayerState): InputLayer {
  if (s.settingsOpen) return 'settings';
  if (s.screen !== 'game') return s.screen;
  if (s.helpOpen) return 'help';
  // same order as the engine: a pending perk is resolved before any choice
  if (s.levelUp) return 'levelup';
  if (s.choice) return 'choice';
  if (s.trade) return 'trade';
  if (s.dialogue) return 'dialogue';
  if (s.backpackOpen) return s.menuOpen ? 'menu' : 'backpack';
  if (s.rulesOpen) return 'rules';
  if (s.mode === 'target') return 'target';
  if (s.mode === 'look') return 'look';
  if (s.narrationVisible) return 'narration';
  return 'game';
}
