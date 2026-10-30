/**
 * The Norwegian bokmål catalog (DESIGN §7b, DoD #11): same keys and params as English, every
 * template parses, plurals pick the right branch, and nothing is left untranslated by accident.
 */
import { afterEach, describe, expect, it } from 'vitest';
import en from '../../src/client/i18n/en';
import nb, { meta } from '../../src/client/i18n/nb';
import { availableLanguages, catalog, formatMessage, messageArgs, parseMessage, setLanguage, t, tx } from '../../src/client/i18n/index';
import { END_REASON_KEYS, LOG_KEYS } from '../../src/engine/log-keys';

const EN = en as Record<string, string>;
const NB = nb as Record<string, string>;

/** values that are legitimately the same in both languages (format-only, loanwords, key caps) */
const SAME_OK = new Set([
  'log.area.enter', 'log.search.terrain', 'log.currency.gain', 'log.xp', 'log.levelup', 'log.perk',
  'end.loss.defeated', 'end.loss.cause', 'end.loss.cause_typed',
  'common.fraction', 'hud.area', 'hud.areaOf', 'hud.money', 'slot.aria.item', 'trade.price',
  'cond.counter', 'cond.areaName', 'cond.defeatedCount', 'vocab.int.abbr', 'vocab.int.name', 'vocab.hp.abbr', 'vocab.mp.name', 'vocab.mp.abbr',
  'rules.srcGm', 'npc.role.rival', 'key.enter', 'key.tab', 'key.esc', 'key.del', 'help.zoom', 'start.label', 'difficulty.normal.label',
  'difficulty.brutal.label', 'settings.note.region',
  // rooms (MP3): the same word in bokmål
  'lobby.start', 'lobby.options.deadlineValue', 'lobby.colours.magenta', 'chat.open', 'chat.send', 'chat.history', 'keys.chat',
  // item effect lines that are only numbers and world words
  'item.fx.resource_gain', 'item.fx.resource_loss', 'item.fx.xp', 'item.fx.currency', 'item.fx.weapon', 'item.fx.modifier', 'item.fx.trigger',
]);

/** all `plural` nodes of a template, with their option keys */
function plurals(tpl: string): string[][] {
  const out: string[][] = [];
  const walk = (nodes: ReturnType<typeof parseMessage>) => {
    for (const n of nodes) {
      if (n.t === 'plural') out.push(Object.keys(n.options));
      if (n.t === 'plural' || n.t === 'select') Object.values(n.options).forEach(walk);
    }
  };
  walk(parseMessage(tpl));
  return out;
}

/** the literal text of a template (all branches), without argument names */
function texts(tpl: string): string {
  let out = '';
  const walk = (nodes: ReturnType<typeof parseMessage>) => {
    for (const n of nodes) {
      if (n.t === 'text') out += n.v;
      else if (n.t === 'plural' || n.t === 'select') Object.values(n.options).forEach((o) => ((out += ' '), walk(o)));
    }
  };
  walk(parseMessage(tpl));
  return out;
}

afterEach(() => setLanguage('en', { persist: false }));

describe('nb catalog: completeness', () => {
  it('is registered under its own name', () => {
    expect(meta.name).toBe('Norsk bokmål');
    expect(availableLanguages()).toContainEqual({ code: 'nb', name: 'Norsk bokmål' });
    expect(catalog('nb')).toBe(nb);
  });

  it('has exactly the English keys (none missing, none extra)', () => {
    const missing = Object.keys(EN).filter((k) => !(k in NB));
    const extra = Object.keys(NB).filter((k) => !(k in EN));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it('covers every engine log key and end reason', () => {
    for (const k of [...Object.keys(LOG_KEYS), ...Object.keys(END_REASON_KEYS)]) expect(NB[k], k).toBeDefined();
  });

  it('every template parses and uses exactly the English params', () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(NB)) {
      expect(() => parseMessage(v), k).not.toThrow();
      const want = messageArgs(EN[k] ?? '').join(',');
      const got = messageArgs(v).join(',');
      if (want !== got) bad.push(`${k}: en {${want}} nb {${got}}`);
    }
    expect(bad).toEqual([]);
  });

  it('plurals have one and other branches wherever English has them', () => {
    for (const [k, v] of Object.entries(NB)) {
      const mine = plurals(v);
      expect(mine.length, k).toBe(plurals(EN[k]!).length);
      for (const opts of mine) expect(opts.includes('other') && (opts.includes('one') || opts.some((o) => o.startsWith('='))), k).toBe(true);
    }
  });

  it('nothing is accidentally left in English', () => {
    const same = Object.keys(NB).filter((k) => NB[k] === EN[k] && !SAME_OK.has(k));
    expect(same).toEqual([]);
    // common English words that never belong in bokmål UI text
    const english = /\b(the|you|your|and|with|press|click|tap|turn|turns|level|items?|slot|backpack|rules?|goal|nothing|someone)\b/i;
    const leaks = Object.entries(NB)
      .filter(([k]) => !k.startsWith('settings.note.') && k !== 'gen.progress.done')
      .map(([k, v]) => [k, texts(v)] as const)
      .filter(([, v]) => english.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(leaks).toEqual([]);
  });

  it('uses Norwegian typography: «» quotes, no English curly quotes', () => {
    for (const [k, v] of Object.entries(NB)) expect(/[“”]/.test(v), `${k}: ${v}`).toBe(false);
    expect(NB['common.quoted']).toBe('«{text}»');
  });
});

describe('nb catalog: rendering', () => {
  it('plural forms', () => {
    expect(formatMessage(NB['status.tip']!, { name: 'Forgiftet', n: 1, description: 'Svir' }, 'nb')).toBe('Forgiftet (1 runde) – Svir');
    expect(formatMessage(NB['status.tip']!, { name: 'Forgiftet', n: 3, description: 'Svir' }, 'nb')).toBe('Forgiftet (3 runder) – Svir');
    expect(formatMessage(NB['hud.pending']!, { n: 2 }, 'nb')).toBe('+2 nivåer');
    expect(formatMessage(NB['start.demosIn']!, { language: 'Norsk bokmål', count: 1 }, 'nb')).toBe('Norsk bokmål: 1 verden');
    expect(formatMessage(NB['start.demosIn']!, { language: 'Norsk bokmål', count: 5 }, 'nb')).toBe('Norsk bokmål: 5 verdener');
    expect(formatMessage(NB['ctx.pickup']!, { item: 'skjema DT-1', more: 0 }, 'nb')).toBe('Plukk opp skjema DT-1');
    expect(formatMessage(NB['ctx.pickup']!, { item: 'skjema DT-1', more: 2 }, 'nb')).toBe('Plukk opp skjema DT-1 +2');
  });

  it('t() and tx() use the catalog once nb is selected', () => {
    setLanguage('nb', { persist: false });
    expect(t('hud.turn', { n: 7 })).toBe('Runde 7');
    expect(t('bp.title')).toBe('Ryggsekk');
    expect(t('actor.talkChip')).toBe('Snakk');
    expect(t('help.pickup')).toBe('Plukk opp');
    // engine log lines: world words come in as params and are kept as they are
    expect(tx('log.item.pickup', { player: 'Kari', item: 'skjema DT-1' }, 'Kari picks up skjema DT-1.')).toBe('Kari plukker opp skjema DT-1.');
    expect(tx('log.attack.hit', { attacker: 'trehode', verb: 'innvender mot', target: 'Kari', amount: 3, hp: 'Tålmodighet' })).toBe(
      'Trehode innvender mot Kari (−3 Tålmodighet).',
    );
    expect(tx('log.defeated', { target: 'nemndleder Skrubb', defeated: 'henlagt' })).toBe('Nemndleder Skrubb er henlagt.');
    expect(tx('end.loss.by', { defeated: 'henlagt', by: 'Trehode' })).toBe('henlagt av Trehode');
    // a key nobody knows still shows the engine text
    expect(tx('log.future.thing', {}, 'Something new.')).toBe('Something new.');
  });

  it('every message renders without leftover placeholders given all its params', () => {
    for (const [k, v] of Object.entries(NB)) {
      const params: Record<string, string | number> = {};
      for (const a of messageArgs(v)) params[a] = /^(n|count|amount|level|turn|max|more|pct|have|from|to|number|of|base)$/.test(a) ? 2 : 'x';
      const out = formatMessage(v, params, 'nb');
      expect(out.includes('{') || out.includes('}'), `${k}: ${out}`).toBe(false);
    }
  });
});
