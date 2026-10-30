import { describe, expect, it } from 'vitest';
import { computeLayer, directionOf, digitIndex, isTextTarget, keyHelp, resolveKey, sameTile, type InputLayer, type LayerState } from '../../src/client/ui/input';

const ALL = { talk: true, sneak: true, search: true, persuade: true };
const NONE = { talk: false, sneak: false, search: false, persuade: false };
const k = (key: string, extra: Partial<{ code: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({ key, ...extra });
const game = (key: string, extra = {}, verbs = ALL) => resolveKey(k(key, extra), 'game', verbs);

describe('movement keys', () => {
  it('arrows, WASD and vi-keys all move', () => {
    expect(game('ArrowUp')).toEqual({ type: 'move', dir: 'n' });
    expect(game('ArrowLeft')).toEqual({ type: 'move', dir: 'w' });
    expect(game('w')).toEqual({ type: 'move', dir: 'n' });
    expect(game('a')).toEqual({ type: 'move', dir: 'w' });
    expect(game('s')).toEqual({ type: 'move', dir: 's' });
    expect(game('d')).toEqual({ type: 'move', dir: 'e' });
    expect(game('h')).toEqual({ type: 'move', dir: 'w' });
    expect(game('j')).toEqual({ type: 'move', dir: 's' });
    expect(game('k')).toEqual({ type: 'move', dir: 'n' });
    expect(game('l')).toEqual({ type: 'move', dir: 'e' });
    expect(game('y')).toEqual({ type: 'move', dir: 'nw' });
    expect(game('u')).toEqual({ type: 'move', dir: 'ne' });
    expect(game('b')).toEqual({ type: 'move', dir: 'sw' });
    expect(game('n')).toEqual({ type: 'move', dir: 'se' });
  });

  it('caps-lock letters still move, shifted capitals do not', () => {
    expect(game('W')).toEqual({ type: 'move', dir: 'n' });
    expect(game('W', { shiftKey: true })).toBeNull();
  });

  it('numpad moves (diagonals too) and numpad 5 waits, distinct from top-row digits', () => {
    expect(game('8', { code: 'Numpad8' })).toEqual({ type: 'move', dir: 'n' });
    expect(game('7', { code: 'Numpad7' })).toEqual({ type: 'move', dir: 'nw' });
    expect(game('3', { code: 'Numpad3' })).toEqual({ type: 'move', dir: 'se' });
    expect(game('5', { code: 'Numpad5' })).toEqual({ type: 'wait' });
    expect(game('Home')).toEqual({ type: 'move', dir: 'nw' });
    expect(game('PageDown')).toEqual({ type: 'move', dir: 'se' });
    expect(game('8', { code: 'Digit8' })).toEqual({ type: 'slot', index: 7 });
  });
});

describe('game keys', () => {
  it('slots 1-8; 9 is unbound', () => {
    expect(game('1')).toEqual({ type: 'slot', index: 0 });
    expect(game('8')).toEqual({ type: 'slot', index: 7 });
    expect(game('9')).toBeNull();
  });

  it('single-key verbs', () => {
    expect(game('g')).toEqual({ type: 'pickup' });
    expect(game(',')).toEqual({ type: 'pickup' });
    expect(game('i')).toEqual({ type: 'backpack' });
    expect(game('Tab')).toEqual({ type: 'backpack' });
    expect(game('Tab', { shiftKey: true })).toBeNull();
    expect(game('x')).toEqual({ type: 'look' });
    expect(game('.')).toEqual({ type: 'wait' });
    expect(game(' ')).toEqual({ type: 'wait' });
    expect(game('>', { shiftKey: true })).toEqual({ type: 'transition' });
    expect(game('?', { shiftKey: true })).toEqual({ type: 'help' });
    expect(game('Escape')).toEqual({ type: 'close' });
    expect(game('r')).toEqual({ type: 'rules' });
    expect(game('m')).toEqual({ type: 'sound' });
    expect(game('M', { shiftKey: true })).toEqual({ type: 'sound' });
  });

  it('search lives on f because s is WASD south', () => {
    expect(game('s')).toEqual({ type: 'move', dir: 's' });
    expect(game('f')).toEqual({ type: 'search' });
  });

  it('verbs are gated by the world', () => {
    expect(game('t')).toEqual({ type: 'talk' });
    expect(game('p')).toEqual({ type: 'persuade' });
    expect(game('c')).toEqual({ type: 'sneak' });
    for (const key of ['t', 'p', 'c', 'f']) expect(game(key, {}, NONE)).toBeNull();
  });

  it('camera rotate and zoom', () => {
    expect(game('q')).toEqual({ type: 'rotate', dir: -1 });
    expect(game('e')).toEqual({ type: 'rotate', dir: 1 });
    expect(game('+', { shiftKey: true })).toEqual({ type: 'zoom', delta: 1 });
    expect(game('=')).toEqual({ type: 'zoom', delta: 1 });
    expect(game('-')).toEqual({ type: 'zoom', delta: -1 });
    expect(game('+', { code: 'NumpadAdd' })).toEqual({ type: 'zoom', delta: 1 });
  });

  it('browser shortcuts with modifiers are left alone', () => {
    expect(game('r', { ctrlKey: true })).toBeNull();
    expect(game('w', { metaKey: true })).toBeNull();
    expect(game('1', { altKey: true })).toBeNull();
  });

  it('no game key binding is shadowed by another (one meaning per key)', () => {
    const keys = 'abcdefghijklmnopqrstuvwxyz.,<>?+-=12345678'.split('');
    const seen = new Map<string, string>();
    for (const key of keys) {
      const cmd = game(key);
      if (cmd) seen.set(key, JSON.stringify(cmd));
    }
    // documented letters must all be bound
    for (const key of ['w', 'a', 's', 'd', 'h', 'j', 'k', 'l', 'y', 'u', 'b', 'n', 'g', 'i', 'x', 't', 'f', 'c', 'q', 'e', 'p', 'r']) {
      expect(seen.has(key), key).toBe(true);
    }
  });
});

describe('other layers', () => {
  it('text inputs only receive Escape', () => {
    expect(resolveKey(k('w'), 'text', ALL)).toBeNull();
    expect(resolveKey(k('1'), 'text', ALL)).toBeNull();
    expect(resolveKey(k('Escape'), 'text', ALL)).toEqual({ type: 'close' });
  });

  it('screens without game input return null', () => {
    for (const layer of ['start', 'loading', 'end', 'none'] as InputLayer[]) expect(resolveKey(k('w'), layer, ALL)).toBeNull();
  });

  it('narration: Enter/Space/Esc skip, movement still works', () => {
    expect(resolveKey(k(' '), 'narration', ALL)).toEqual({ type: 'skip' });
    expect(resolveKey(k('Enter'), 'narration', ALL)).toEqual({ type: 'skip' });
    expect(resolveKey(k('Escape'), 'narration', ALL)).toEqual({ type: 'skip' });
    expect(resolveKey(k('ArrowUp'), 'narration', ALL)).toEqual({ type: 'move', dir: 'n' });
  });

  it('look and target modes move a cursor', () => {
    expect(resolveKey(k('l'), 'look', ALL)).toEqual({ type: 'nav', dir: 'e' });
    expect(resolveKey(k('x'), 'look', ALL)).toEqual({ type: 'close' });
    expect(resolveKey(k('Enter'), 'look', ALL)).toEqual({ type: 'confirm' });
    expect(resolveKey(k('Escape'), 'target', ALL)).toEqual({ type: 'close' });
    expect(resolveKey(k('3'), 'target', ALL)).toEqual({ type: 'slot', index: 2 });
    expect(resolveKey(k(' '), 'target', ALL)).toEqual({ type: 'confirm' });
  });

  it('backpack: grid navigation, actions, digits assign quick slots', () => {
    expect(resolveKey(k('ArrowDown'), 'backpack', ALL)).toEqual({ type: 'nav', dir: 's' });
    expect(resolveKey(k('d'), 'backpack', ALL)).toEqual({ type: 'nav', dir: 'e' });
    expect(resolveKey(k('j'), 'backpack', ALL)).toEqual({ type: 'nav', dir: 's' });
    expect(resolveKey(k('Enter'), 'backpack', ALL)).toEqual({ type: 'confirm' });
    expect(resolveKey(k('3'), 'backpack', ALL)).toEqual({ type: 'option', index: 2 });
    expect(resolveKey(k('u'), 'backpack', ALL)).toEqual({ type: 'menu_key', key: 'u' });
    expect(resolveKey(k('e'), 'backpack', ALL)).toEqual({ type: 'menu_key', key: 'e' });
    expect(resolveKey(k('m'), 'backpack', ALL)).toEqual({ type: 'menu_key', key: 'm' });
    expect(resolveKey(k('Delete'), 'backpack', ALL)).toEqual({ type: 'menu_key', key: 'Delete' });
    expect(resolveKey(k('Backspace'), 'backpack', ALL)).toEqual({ type: 'menu_key', key: 'Delete' });
    for (const c of ['Escape', 'Tab', 'i']) expect(resolveKey(k(c), 'backpack', ALL)).toEqual({ type: 'close' });
  });

  it('menu: up/down only', () => {
    expect(resolveKey(k('ArrowDown'), 'menu', ALL)).toEqual({ type: 'nav', dir: 's' });
    expect(resolveKey(k('ArrowLeft'), 'menu', ALL)).toBeNull();
    expect(resolveKey(k('Escape'), 'menu', ALL)).toEqual({ type: 'close' });
  });

  it('dialogue can be left with Esc; choices and perk picks cannot', () => {
    expect(resolveKey(k('Escape'), 'dialogue', ALL)).toEqual({ type: 'close' });
    expect(resolveKey(k('Escape'), 'trade', ALL)).toEqual({ type: 'close' });
    expect(resolveKey(k('Escape'), 'choice', ALL)).toBeNull();
    expect(resolveKey(k('Escape'), 'levelup', ALL)).toBeNull();
    expect(resolveKey(k('2'), 'choice', ALL)).toEqual({ type: 'option', index: 1 });
    expect(resolveKey(k('ArrowDown'), 'levelup', ALL)).toEqual({ type: 'nav', dir: 's' });
    expect(resolveKey(k('w'), 'dialogue', ALL)).toBeNull();
  });

  it('help/rules close on Esc, ? and r', () => {
    expect(resolveKey(k('?'), 'help', ALL)).toEqual({ type: 'close' });
    expect(resolveKey(k('r'), 'rules', ALL)).toEqual({ type: 'close' });
    expect(resolveKey(k('Escape'), 'settings', ALL)).toEqual({ type: 'close' });
    expect(resolveKey(k('w'), 'settings', ALL)).toBeNull();
  });
});

describe('helpers', () => {
  it('directionOf with grid scheme ignores vi diagonals', () => {
    expect(directionOf(k('y'), 'grid')).toBeNull();
    expect(directionOf(k('y'), 'full')).toBe('nw');
    expect(directionOf(k('Home'), 'grid')).toBeNull();
  });

  it('digitIndex ignores numpad', () => {
    expect(digitIndex(k('4'))).toBe(3);
    expect(digitIndex(k('4', { code: 'Numpad4' }))).toBeNull();
    expect(digitIndex(k('!', { code: 'Digit1', shiftKey: true }))).toBeNull();
    expect(digitIndex(k('0'))).toBeNull();
  });

  it('isTextTarget recognises editable elements', () => {
    expect(isTextTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTextTarget({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget)).toBe(true);
    expect(isTextTarget({ tagName: 'INPUT', type: 'range' } as unknown as EventTarget)).toBe(false);
    expect(isTextTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTextTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTextTarget(null)).toBe(false);
  });

  it('sameTile', () => {
    expect(sameTile(null, null)).toBe(true);
    expect(sameTile({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(sameTile({ x: 1, y: 2 }, null)).toBe(false);
  });
});

describe('help content', () => {
  it('lists only enabled verbs, uses the conflict word and transition name', () => {
    const all = keyHelp(ALL, { conflict: 'Put-down' }, 'Board the 6:15 train');
    const play = all[0].rows.map((r) => r.what).join(' | ');
    expect(play).toContain('put-down');
    expect(play).toContain('Board the 6:15 train');
    expect(play).toContain('Search here');
    const none = keyHelp(NONE, { conflict: 'Attack' })[0].rows.map((r) => r.keys.join(' '));
    expect(none).not.toContain('f');
    expect(none).not.toContain('t');
    expect(none).not.toContain('c');
  });

  it('every documented single-letter play key really is bound', () => {
    for (const s of keyHelp(ALL, { conflict: 'Attack' }).slice(0, 2)) {
      for (const r of s.rows) {
        for (const key of r.keys) {
          if (key.length === 1 && /[a-z.,>?]/.test(key)) expect(resolveKey(k(key), 'game', ALL), key).not.toBeNull();
        }
      }
    }
  });

  it('is genre-neutral', () => {
    const text = JSON.stringify(keyHelp(ALL, { conflict: 'Attack' })).toLowerCase();
    for (const w of ['monster', 'dungeon', 'potion', 'spell', 'sword', 'stairs']) expect(text).not.toContain(w);
  });
});

describe('computeLayer', () => {
  const base: LayerState = {
    screen: 'game',
    settingsOpen: false,
    helpOpen: false,
    rulesOpen: false,
    backpackOpen: false,
    menuOpen: false,
    narrationVisible: false,
    choice: false,
    levelUp: false,
    dialogue: false,
    trade: false,
    mode: 'normal',
  };

  it('defaults to game and follows screens', () => {
    expect(computeLayer(base)).toBe('game');
    expect(computeLayer({ ...base, screen: 'start' })).toBe('start');
    expect(computeLayer({ ...base, screen: 'end', helpOpen: true })).toBe('end');
  });

  it('respects priority: settings > help > levelup > choice > trade > dialogue > backpack > rules > target > look > narration', () => {
    const all: LayerState = { ...base, settingsOpen: true, helpOpen: true, choice: true, levelUp: true, trade: true, dialogue: true, backpackOpen: true, menuOpen: true, rulesOpen: true, mode: 'target', narrationVisible: true };
    const order: [Partial<LayerState>, InputLayer][] = [
      [{}, 'settings'],
      [{ settingsOpen: false }, 'help'],
      [{ helpOpen: false }, 'levelup'],
      [{ levelUp: false }, 'choice'],
      [{ choice: false }, 'trade'],
      [{ trade: false }, 'dialogue'],
      [{ dialogue: false }, 'menu'],
      [{ menuOpen: false }, 'backpack'],
      [{ backpackOpen: false }, 'rules'],
      [{ rulesOpen: false }, 'target'],
      [{ mode: 'look' }, 'look'],
      [{ mode: 'normal' }, 'narration'],
      [{ narrationVisible: false }, 'game'],
    ];
    let s = all;
    for (const [change, expected] of order) {
      s = { ...s, ...change };
      expect(computeLayer(s)).toBe(expected);
    }
  });
});

describe('the lobby layer (MP3)', () => {
  const base: LayerState = {
    screen: 'lobby',
    settingsOpen: false,
    helpOpen: false,
    rulesOpen: false,
    backpackOpen: false,
    menuOpen: false,
    narrationVisible: false,
    choice: false,
    levelUp: false,
    dialogue: false,
    trade: false,
    mode: 'normal',
  };

  it('the lobby screen is its own layer; settings (and the name sheet) go over it', () => {
    expect(computeLayer(base)).toBe('lobby');
    expect(computeLayer({ ...base, helpOpen: true, backpackOpen: true })).toBe('lobby');
    expect(computeLayer({ ...base, settingsOpen: true })).toBe('settings');
  });

  it('no game key fires in the lobby (the page keeps Tab, Enter and typing)', () => {
    for (const key of ['w', 'a', 's', 'd', 'ArrowUp', '1', ' ', '.', 'Enter', 'Tab', 'i', 'g', '>', 'Escape', '?', 'r']) expect(resolveKey(k(key), 'lobby', ALL)).toBeNull();
  });

  it('in the text layer (the name sheet, the code field) only Esc means something', () => {
    for (const key of ['w', 'a', 's', 'd', '1', ' ', 'Enter', 'Tab']) expect(resolveKey(k(key), 'text', ALL)).toBeNull();
    expect(resolveKey(k('Escape'), 'text', ALL)).toEqual({ type: 'close' });
  });
});

describe('room keys (MP3 D4)', () => {
  const room = (key: string, layer: InputLayer, extra = {}) => resolveKey(k(key, extra), layer, ALL, true);

  it('in a room Enter opens the chat, Shift+Enter uses what is next to you, `/` opens the chat', () => {
    expect(room('Enter', 'game')).toEqual({ type: 'chat' });
    expect(room('Enter', 'game', { code: 'NumpadEnter' })).toEqual({ type: 'chat' });
    expect(room('Enter', 'game', { shiftKey: true })).toEqual({ type: 'interact' });
    expect(room('/', 'game')).toEqual({ type: 'chat' });
    // single player: Enter still uses, `/` does nothing
    expect(game('Enter')).toEqual({ type: 'interact' });
    expect(game('/')).toBeNull();
  });

  it('`[` / `]` watch the previous / next teammate; Tab stays the backpack', () => {
    expect(room('[', 'game')).toEqual({ type: 'follow', dir: -1 });
    expect(room(']', 'game')).toEqual({ type: 'follow', dir: 1 });
    expect(room('Tab', 'game')).toEqual({ type: 'backpack' });
    expect(game('[')).toBeNull();
  });

  it('`/` opens the chat in every non-text layer, where Enter keeps its meaning', () => {
    for (const l of ['dialogue', 'trade', 'choice', 'levelup', 'narration', 'look', 'target', 'backpack', 'menu', 'help', 'rules', 'lobby', 'end'] as InputLayer[]) expect(room('/', l), l).toEqual({ type: 'chat' });
    expect(room('Enter', 'dialogue')).toEqual({ type: 'confirm' });
    expect(room('Enter', 'choice')).toEqual({ type: 'confirm' });
    expect(room('Enter', 'narration')).toEqual({ type: 'skip' });
    expect(room('Enter', 'look')).toEqual({ type: 'confirm' });
    expect(room('Enter', 'backpack')).toEqual({ type: 'confirm' });
    // the lobby and the end screen keep Enter for their buttons
    expect(room('Enter', 'lobby')).toBeNull();
  });

  it('a text field (the chat input itself) and the settings get no game key, `/` included', () => {
    for (const key of ['w', 'a', 's', 'd', '1', ' ', 'Enter', '/', '[', 'Tab']) expect(room(key, 'text'), key).toBeNull();
    expect(room('Escape', 'text')).toEqual({ type: 'close' });
    expect(room('/', 'settings')).toBeNull();
    expect(room('/', 'start')).toBeNull();
  });

  it('the key help names the room keys', () => {
    const rows = keyHelp(ALL, { conflict: 'Fight' }, undefined, true).flatMap((s) => s.rows);
    expect(rows.some((r) => r.keys.includes('/') && r.what === 'Chat')).toBe(true);
    expect(rows.some((r) => r.keys.includes('[') && r.keys.includes(']'))).toBe(true);
    expect(rows.some((r) => r.keys.some((x) => x.includes('⇧')))).toBe(true);
    const sp = keyHelp(ALL, { conflict: 'Fight' }).flatMap((s) => s.rows);
    expect(sp.some((r) => r.keys.includes('/'))).toBe(false);
  });
});
