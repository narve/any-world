/**
 * A small ICU MessageFormat subset for the UI catalogs (DESIGN §7b). Pure, no DOM.
 *
 *   "Hello {name}"                                   simple argument
 *   "{n, plural, =0 {nothing} one {# turn} other {# turns}}"   plural (Intl.PluralRules), `#` = the number
 *   "{kind, select, door {a door} other {something}}" select on a string argument
 *   "{name|cap} arrives"                             argument with its first letter upper-cased
 *                                                     (the engine's log-key templates use this)
 *
 * Branches can nest. A literal brace is written as '{' or '}' (ICU apostrophe quoting); a doubled
 * apostrophe '' is one apostrophe. Missing arguments render as "{name}" so a bad call is visible
 * instead of silently empty.
 */

export type MessageParams = Record<string, string | number | null | undefined>;

type Node =
  | { t: 'text'; v: string }
  | { t: 'arg'; name: string; cap?: boolean }
  | { t: 'hash' }
  | { t: 'plural'; name: string; offset: number; options: Record<string, Node[]> }
  | { t: 'select'; name: string; options: Record<string, Node[]> };

export class MessageSyntaxError extends Error {
  constructor(message: string, readonly template: string) {
    super(`${message} in message "${template}"`);
  }
}

class Parser {
  i = 0;
  constructor(readonly src: string) {}

  fail(msg: string): never {
    throw new MessageSyntaxError(`${msg} at ${this.i}`, this.src);
  }

  /** a message up to (not including) a closing brace at depth 0, or the end */
  message(inPlural: boolean, nested: boolean): Node[] {
    const out: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push({ t: 'text', v: text });
      text = '';
    };
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === "'") {
        // '' → ', '{…}' → literal braces
        const next = this.src[this.i + 1];
        if (next === "'") {
          text += "'";
          this.i += 2;
          continue;
        }
        if (next === '{' || next === '}' || next === '#') {
          const end = this.src.indexOf("'", this.i + 1);
          if (end < 0) this.fail('unterminated quote');
          text += this.src.slice(this.i + 1, end);
          this.i = end + 1;
          continue;
        }
        text += c;
        this.i++;
        continue;
      }
      if (c === '{') {
        flush();
        out.push(this.argument());
        continue;
      }
      if (c === '}') {
        if (!nested) this.fail('unexpected "}"');
        break;
      }
      if (c === '#' && inPlural) {
        flush();
        out.push({ t: 'hash' });
        this.i++;
        continue;
      }
      text += c;
      this.i++;
    }
    flush();
    return out;
  }

  ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  word(): string {
    this.ws();
    const m = /^[^\s,{}]+/.exec(this.src.slice(this.i));
    if (!m) this.fail('expected a name');
    this.i += m[0].length;
    return m[0];
  }

  argument(): Node {
    this.i++; // {
    const word = this.word();
    const [name, ...mods] = word.split('|');
    if (!name) this.fail('expected a name');
    this.ws();
    if (this.src[this.i] === '}') {
      this.i++;
      for (const m of mods) if (m !== 'cap') this.fail(`unknown modifier "${m}"`);
      return mods.includes('cap') ? { t: 'arg', name, cap: true } : { t: 'arg', name };
    }
    if (mods.length) this.fail('modifiers only work on simple arguments');
    if (this.src[this.i] !== ',') this.fail('expected "," or "}"');
    this.i++;
    const kind = this.word();
    if (kind !== 'plural' && kind !== 'select') this.fail(`unknown argument type "${kind}"`);
    this.ws();
    if (this.src[this.i] !== ',') this.fail('expected ","');
    this.i++;
    let offset = 0;
    const options: Record<string, Node[]> = {};
    for (;;) {
      this.ws();
      if (this.src[this.i] === '}') {
        this.i++;
        break;
      }
      if (this.i >= this.src.length) this.fail('unterminated argument');
      const key = this.word();
      if (key.startsWith('offset:')) {
        offset = Number(key.slice(7));
        if (!Number.isFinite(offset)) this.fail('bad offset');
        continue;
      }
      this.ws();
      if (this.src[this.i] !== '{') this.fail(`expected "{" after "${key}"`);
      this.i++;
      options[key] = this.message(kind === 'plural', true);
      if (this.src[this.i] !== '}') this.fail('unterminated option');
      this.i++;
    }
    if (!options.other) this.fail(`${kind} needs an "other" option`);
    return kind === 'plural' ? { t: 'plural', name, offset, options } : { t: 'select', name, options };
  }
}

const cache = new Map<string, Node[]>();

/** parse (cached); throws MessageSyntaxError on a malformed template */
export function parseMessage(template: string): Node[] {
  let ast = cache.get(template);
  if (!ast) {
    const p = new Parser(template);
    ast = p.message(false, false);
    if (p.i < template.length) p.fail('trailing input');
    cache.set(template, ast);
  }
  return ast;
}

/** the argument names a template uses (for catalog consistency checks) */
export function messageArgs(template: string): string[] {
  const out = new Set<string>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.t === 'arg') out.add(n.name);
      else if (n.t === 'plural' || n.t === 'select') {
        out.add(n.name);
        Object.values(n.options).forEach(walk);
      }
    }
  };
  walk(parseMessage(template));
  return [...out].sort();
}

const pluralRules = new Map<string, Intl.PluralRules>();

function pluralCategory(lang: string, n: number): string {
  let pr = pluralRules.get(lang);
  if (!pr) {
    try {
      pr = new Intl.PluralRules(lang);
    } catch {
      pr = new Intl.PluralRules('en');
    }
    pluralRules.set(lang, pr);
  }
  return pr.select(n);
}

function render(nodes: Node[], params: MessageParams, lang: string, hash: number | null): string {
  let s = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        s += n.v;
        break;
      case 'hash':
        s += hash === null ? '#' : String(hash);
        break;
      case 'arg': {
        const v = params[n.name];
        const str = v === undefined || v === null ? `{${n.name}}` : String(v);
        s += n.cap && str ? str.charAt(0).toLocaleUpperCase(lang) + str.slice(1) : str;
        break;
      }
      case 'plural': {
        const raw = Number(params[n.name]);
        const v = Number.isFinite(raw) ? raw : 0;
        const exact = n.options[`=${v}`];
        const branch = exact ?? n.options[pluralCategory(lang, v - n.offset)] ?? n.options.other;
        s += render(branch, params, lang, v - n.offset);
        break;
      }
      case 'select': {
        const v = params[n.name];
        const branch = (v !== undefined && v !== null && n.options[String(v)]) || n.options.other;
        s += render(branch, params, lang, hash);
        break;
      }
    }
  }
  return s;
}

/** format `template` with `params` for language `lang` (plural rules) */
export function formatMessage(template: string, params: MessageParams = {}, lang = 'en'): string {
  // fast path: nothing to substitute
  if (!/[{}#']/.test(template)) return template;
  try {
    return render(parseMessage(template), params, lang, null);
  } catch (e) {
    if (e instanceof MessageSyntaxError) return template;
    throw e;
  }
}
