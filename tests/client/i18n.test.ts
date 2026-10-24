/**
 * UI message catalogs (DESIGN §7b): the formatter, language selection, and the catalog checks
 * that keep "adding a language = adding a catalog file" honest:
 *  - every key the client uses through t('…') exists in en.ts (fails on a missing key),
 *  - every engine log key / end reason key has an English entry with the engine's params,
 *  - every other catalog has every English key with the same params,
 *  - no new hard-coded English text in the overlay components.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import en from '../../src/client/i18n/en';
import {
  availableLanguages,
  catalog,
  detectLanguage,
  formatMessage,
  getLanguage,
  hasKey,
  listJoin,
  messageArgs,
  normalizeLanguage,
  parseMessage,
  registerCatalog,
  setLanguage,
  t,
  tx,
} from '../../src/client/i18n/index';
import { END_REASON_KEYS, LOG_KEYS, templateParams } from '../../src/engine/log-keys';
import { logLineText } from '../../src/client/ui/components/log';
import { DEFAULT_VOCABULARY } from '../../src/client/ui/format';

const CLIENT = join(__dirname, '../../src/client');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** string literals inside the first argument of every t( / tr( call */
function usedKeys(src: string): string[] {
  const out: string[] = [];
  const re = /(?<![\w.])(?:t|tr)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // the first argument: up to the first top-level ',' or ')'
    let depth = 0;
    let i = m.index + m[0].length;
    let arg = '';
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
      arg += c;
    }
    for (const lit of arg.matchAll(/'([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)'/g)) out.push(lit[1]);
  }
  return out;
}

afterEach(() => setLanguage('en', { persist: false }));

describe('formatMessage (ICU subset)', () => {
  it('substitutes, capitalises and leaves unknown params visible', () => {
    expect(formatMessage('Hello {name}', { name: 'Ines' })).toBe('Hello Ines');
    expect(formatMessage('{who|cap} arrives', { who: 'the rat' })).toBe('The rat arrives');
    expect(formatMessage('Hello {name}')).toBe('Hello {name}');
    expect(formatMessage('no params at all')).toBe('no params at all');
  });

  it('plural with exact matches, # and per-language rules', () => {
    const m = '{n, plural, =0 {nothing} one {# turn} other {# turns}}';
    expect(formatMessage(m, { n: 0 })).toBe('nothing');
    expect(formatMessage(m, { n: 1 })).toBe('1 turn');
    expect(formatMessage(m, { n: 5 })).toBe('5 turns');
    // Norwegian has the same one/other split; a language without plurals uses other
    expect(formatMessage(m, { n: 1 }, 'nb')).toBe('1 turn');
    expect(formatMessage('{n, plural, one {# kind} other {# kinds}}', { n: 1 }, 'ja')).toBe('1 kinds');
  });

  it('select and nesting', () => {
    const m = '{level, select, empty {{label} is empty} other {{label} is low ({n, plural, one {# left} other {# left}})}}';
    expect(formatMessage(m, { level: 'empty', label: 'O2' })).toBe('O2 is empty');
    expect(formatMessage(m, { level: 'low', label: 'O2', n: 3 })).toBe('O2 is low (3 left)');
  });

  it('apostrophes: plain ones stay, quoted braces are literal', () => {
    expect(formatMessage("{player} can't act.", { player: 'Ines' })).toBe("Ines can't act.");
    expect(formatMessage("use '{' and '}'")).toBe('use { and }');
    expect(formatMessage("it''s")).toBe("it's");
  });

  it('a malformed template is shown as is instead of throwing', () => {
    expect(formatMessage('broken {n, plural, one {x}}', { n: 1 })).toBe('broken {n, plural, one {x}}');
    expect(() => parseMessage('{n, plural, one {x}}')).toThrow(/other/);
    expect(() => parseMessage('{a|shout}')).toThrow(/modifier/);
  });

  it('lists the arguments a template uses', () => {
    expect(messageArgs('{a} {b|cap} {n, plural, one {# {c}} other {#}}')).toEqual(['a', 'b', 'c', 'n']);
  });
});

describe('language selection', () => {
  it('Norwegian of any kind is nb; English is en; anything else falls back to en', () => {
    expect(normalizeLanguage('nb-NO')).toBe('nb');
    expect(normalizeLanguage('no')).toBe('nb');
    expect(normalizeLanguage('nn')).toBe('nb');
    expect(detectLanguage(['nb-NO', 'en'])).toBe('nb');
    expect(detectLanguage(['nn'])).toBe('nb');
    expect(detectLanguage(['en-GB'])).toBe('en');
    expect(detectLanguage(['de-DE'])).toBe('en');
    expect(detectLanguage(['de-DE', 'no'])).toBe('nb');
    expect(detectLanguage([])).toBe('en');
    expect(detectLanguage(undefined)).toBe('en');
  });

  it('defaults to English outside a browser', () => {
    expect(getLanguage()).toBe('en');
    expect(t('hud.turn', { n: 3 })).toBe('Turn 3');
  });

  it('a registered catalog is used, with English for its missing keys', () => {
    registerCatalog('xx', { 'hud.turn': 'Runde {n}' }, 'Test');
    setLanguage('xx', { persist: false });
    expect(getLanguage()).toBe('xx');
    expect(t('hud.turn', { n: 3 })).toBe('Runde 3');
    expect(t('trade.buy')).toBe('Buy');
    expect(availableLanguages().map((l) => l.code)).toContain('xx');
    expect(availableLanguages()[0].code).toBe('en');
  });

  it('tx renders dynamic keys and falls back to the given text', () => {
    expect(tx('log.item.pickup', { player: 'Ines', item: 'a lamp' })).toBe('Ines picks up a lamp.');
    expect(tx('log.no.such.key', {}, 'fallback text')).toBe('fallback text');
    expect(hasKey('log.item.pickup')).toBe(true);
    expect(hasKey('log.no.such.key')).toBe(false);
  });

  it('joins lists in the UI language', () => {
    expect(listJoin(['O2'])).toBe('O2');
    expect(listJoin(['Health', 'O2'])).toBe('Health and O2');
    expect(listJoin(['a', 'b', 'c'], 'or')).toBe('a, b, or c');
  });
});

describe('the English catalog', () => {
  it('has every key the client uses through t()', () => {
    const missing: string[] = [];
    let total = 0;
    for (const f of files(CLIENT)) {
      for (const key of usedKeys(readFileSync(f, 'utf8'))) {
        total++;
        if (!(key in en)) missing.push(`${relative(CLIENT, f)}: ${key}`);
      }
    }
    expect(total).toBeGreaterThan(300);
    expect(missing).toEqual([]);
  });

  it('every template parses', () => {
    for (const [k, v] of Object.entries(en)) expect(() => parseMessage(v), k).not.toThrow();
  });

  it('covers every engine log key and end reason with the engine params (plus the health word)', () => {
    const engine: Record<string, string> = { ...LOG_KEYS, ...END_REASON_KEYS };
    for (const [k, tpl] of Object.entries(engine)) {
      const mine = (en as Record<string, string>)[k];
      expect(mine, k).toBeDefined();
      const extra = messageArgs(mine).filter((a) => !templateParams(tpl).includes(a) && a !== 'hp');
      expect(extra, k).toEqual([]);
    }
  });

  it('renders engine log lines through the catalog, naming untyped harm with the world word', () => {
    const vocab = { stats: { ...DEFAULT_VOCABULARY.stats, hp: { name: 'Composure', abbr: 'CMP', description: '' } } };
    const line = { turn: 1, kind: 'combat' as const, text: 'The rat bites Ines for 3.', key: 'log.attack.hit', params: { attacker: 'the rat', verb: 'bites', target: 'Ines', amount: 3 } };
    expect(logLineText(line, vocab)).toBe('The rat bites Ines for 3 Composure.');
    // no key: the M2 path (English text, health word added)
    expect(logLineText({ turn: 1, kind: 'combat', text: 'Ines takes 2.' }, vocab)).toBe('Ines takes 2 Composure.');
    // GM and NPC lines are world text: never touched
    expect(logLineText({ turn: 1, kind: 'gm', text: 'takes 2.', key: 'log.damage.take' }, vocab)).toBe('takes 2.');
    // a key no catalog knows shows the engine's own text
    expect(logLineText({ turn: 1, kind: 'info', text: 'Something new.', key: 'log.future.thing' }, vocab)).toBe('Something new.');
  });
});

describe('other catalogs', () => {
  const codes = availableLanguages()
    .map((l) => l.code)
    .filter((c) => c !== 'en' && c !== 'xx');
  it.each(codes.length ? codes : ['(none yet)'])('%s has every English key with the same params', (code) => {
    if (code === '(none yet)') return;
    const cat = catalog(code)!;
    const missing = Object.keys(en).filter((k) => !(k in cat));
    expect(missing).toEqual([]);
    for (const [k, v] of Object.entries(cat)) {
      expect(() => parseMessage(v), `${code} ${k}`).not.toThrow();
      const enTpl = (en as Record<string, string>)[k];
      if (enTpl === undefined) continue;
      const extra = messageArgs(v).filter((a) => !messageArgs(enTpl).includes(a));
      expect(extra, `${code} ${k}`).toEqual([]);
    }
  });
});

describe('no hard-coded English in the overlay', () => {
  it('components pass catalog text, not literal English, as element text', () => {
    const dirs = [join(CLIENT, 'ui/components'), join(CLIENT, 'ui/ui.ts')];
    const offenders: string[] = [];
    for (const d of dirs) {
      for (const f of statSync(d).isDirectory() ? files(d) : [d]) {
        const src = readFileSync(f, 'utf8');
        src.split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          // text children: h('tag', props, 'Some words') / , 'Words'),
          for (const m of line.matchAll(/(?:null|\}|\)),\s*'([A-Z][a-z]+(?: [a-z]+)*[.!?…]?)'/g)) {
            if (['Any', 'World'].includes(m[1])) continue; // the logo
            offenders.push(`${relative(CLIENT, f)}:${i + 1}: ${m[1]}`);
          }
          for (const m of line.matchAll(/'aria-label':\s*'([^']+)'/g)) offenders.push(`${relative(CLIENT, f)}:${i + 1}: aria ${m[1]}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
