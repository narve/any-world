/**
 * Condensed, TypeScript-style descriptions of zod schemas for prompts.
 *
 * The full JSON Schema of a World Spec is ~110k characters: too big and too noisy to send with every
 * request. This module walks the zod schema itself (so the description can never drift from the
 * contract) and prints compact type declarations:
 *
 *   type Amount = { base?: number = 0; dice?: string /dice like 2d6/; scale?: { stat: StatRef; factor: number } }
 *
 * Notation (explained to the model by SCHEMA_NOTATION):
 *   field?: T = d   optional, default d          T[a..b]  array of a..b items      T[≤b] at most b
 *   int 1..30       integer range                 number 0..1  number range
 *   string≤40       max 40 characters             "a" | "b"    one of these strings
 *   // text         a short note on the field (hand-written in `notes`, keyed "Type.field")
 *
 * Browser-safe; uses zod v4 internals (`_zod.def`), which are stable within zod 4.x.
 */
import type { z } from 'zod';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyZod = z.ZodType;

interface Def {
  type: string;
  [k: string]: any;
}

function defOf(s: AnyZod): Def {
  return (s as any)._zod.def as Def;
}

export const SCHEMA_NOTATION = [
  'Notation: `field?: T = d` optional with default d (omit it to get d); `T[a..b]` an array of a to b items, `T[≤b]` at most b;',
  '`int 1..30` an integer range; `number 0..1` a number range; `string≤40` at most 40 characters; `"a" | "b"` one of these strings;',
  '`{ [key: K]: V }` an object map; `// …` a note. Named types (Id, Color, Amount, …) are declared once and referenced by name.',
].join('\n');

export interface SchemaDocOptions {
  /** schemas printed as named `type X = …` declarations, in this order */
  named: [string, AnyZod][];
  /** notes appended to fields: key "TypeName.field" (top-level fields of named object types) */
  notes?: Record<string, string>;
  /** only print named types reachable from these names (default: all) */
  roots?: string[];
  /** inline objects whose one-line form is at most this long (default 110) */
  inlineWidth?: number;
}

interface Checks {
  min?: number;
  max?: number;
  minInclusive?: boolean;
  maxInclusive?: boolean;
  int?: boolean;
  minLen?: number;
  maxLen?: number;
  regex?: { pattern: RegExp; message?: string };
}

function checksOf(d: Def): Checks {
  const out: Checks = {};
  for (const c of (d.checks ?? []) as any[]) {
    const cd = c?._zod?.def ?? c;
    switch (cd.check) {
      case 'greater_than':
        out.min = cd.value;
        out.minInclusive = cd.inclusive;
        break;
      case 'less_than':
        out.max = cd.value;
        out.maxInclusive = cd.inclusive;
        break;
      case 'number_format':
        if (/int/.test(String(cd.format))) out.int = true;
        break;
      case 'min_length':
        out.minLen = cd.minimum;
        break;
      case 'max_length':
        out.maxLen = cd.maximum;
        break;
      case 'length_equals':
        out.minLen = cd.length;
        out.maxLen = cd.length;
        break;
      case 'string_format':
        if (cd.format === 'regex' && cd.pattern instanceof RegExp) {
          let message: string | undefined;
          try {
            const r = typeof cd.error === 'function' ? cd.error({}) : cd.error;
            message = typeof r === 'string' ? r : typeof r?.message === 'string' ? r.message : undefined;
          } catch {
            message = undefined;
          }
          out.regex = { pattern: cd.pattern, message };
        }
        break;
    }
  }
  return out;
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(4));
}

function fmtDefault(v: unknown): string {
  const text = JSON.stringify(v);
  if (text === undefined) return '…';
  return text.length <= 48 ? text : '{…}';
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Collects every named type reachable from a schema (used for `roots`). */
function reachable(start: AnyZod[], names: Map<AnyZod, string>): Set<string> {
  const seen = new Set<AnyZod>();
  const found = new Set<string>();
  const visit = (s: AnyZod | undefined, top = false): void => {
    if (!s || typeof s !== 'object') return;
    const n = names.get(s);
    if (n && !top) {
      if (found.has(n)) return;
      found.add(n);
    }
    if (seen.has(s)) return;
    seen.add(s);
    const d = defOf(s);
    switch (d.type) {
      case 'object':
        for (const v of Object.values(d.shape as Record<string, AnyZod>)) visit(v);
        break;
      case 'optional':
      case 'default':
      case 'nullable':
      case 'readonly':
      case 'nonoptional':
      case 'prefault':
      case 'catch':
        visit(d.innerType);
        break;
      case 'lazy':
        visit(d.getter());
        break;
      case 'array':
        visit(d.element);
        break;
      case 'union':
        for (const o of d.options as AnyZod[]) visit(o);
        break;
      case 'record':
        visit(d.keyType);
        visit(d.valueType);
        break;
      case 'tuple':
        for (const o of d.items as AnyZod[]) visit(o);
        break;
      case 'pipe':
        visit(d.in);
        break;
    }
  };
  for (const s of start) {
    const n = names.get(s);
    if (n) found.add(n);
    visit(s, true);
  }
  return found;
}

export class SchemaDoc {
  private readonly names = new Map<AnyZod, string>();
  private readonly notes: Record<string, string>;
  private readonly width: number;

  constructor(private readonly opts: SchemaDocOptions) {
    for (const [n, s] of opts.named) this.names.set(s, n);
    this.notes = opts.notes ?? {};
    this.width = opts.inlineWidth ?? 110;
  }

  /** the whole document: one `type X = …` per named type */
  render(): string {
    const roots = this.opts.roots;
    const keep = roots
      ? reachable(
          roots.map((r) => {
            const s = this.opts.named.find(([n]) => n === r)?.[1];
            if (!s) throw new Error(`schema-doc: unknown root ${r}`);
            return s;
          }),
          this.names,
        )
      : null;
    const out: string[] = [];
    for (const [name, schema] of this.opts.named) {
      if (keep && !keep.has(name)) continue;
      out.push(this.declaration(name, schema));
    }
    return out.join('\n');
  }

  /** `type Name = …` for one named schema */
  declaration(name: string, schema: AnyZod): string {
    let s = schema;
    // the declaration shows the definition, not a reference to itself
    let d = defOf(s);
    while (d.type === 'lazy') {
      s = d.getter();
      d = defOf(s);
    }
    const body = this.type(s, '', name, true);
    return `type ${name} =${body.startsWith('\n') ? '' : ' '}${body}`;
  }

  /** type expression for a schema; `owner` names the enclosing named type (for notes) */
  private type(s: AnyZod, indent: string, owner?: string, isDecl = false): string {
    const named = this.names.get(s);
    if (named && !isDecl) return named;
    const d = defOf(s);
    switch (d.type) {
      case 'string':
        return this.stringType(d);
      case 'number': {
        const c = checksOf(d);
        const base = c.int ? 'int' : 'number';
        if (c.min !== undefined && c.max !== undefined) return `${base} ${fmtNum(c.min)}..${fmtNum(c.max)}`;
        if (c.min !== undefined) return `${base} ≥${fmtNum(c.min)}`;
        if (c.max !== undefined) return `${base} ≤${fmtNum(c.max)}`;
        return base;
      }
      case 'int':
        return 'int';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'any':
      case 'unknown':
        return 'any';
      case 'enum':
        return Object.values(d.entries as Record<string, string | number>)
          .map((v) => JSON.stringify(v))
          .join(' | ');
      case 'literal':
        return (d.values as unknown[]).map((v) => JSON.stringify(v)).join(' | ');
      case 'optional':
      case 'default':
      case 'nullable':
      case 'readonly':
      case 'nonoptional':
      case 'prefault':
      case 'catch':
        return this.type(d.innerType, indent, owner);
      case 'lazy':
        return this.type(d.getter(), indent, owner);
      case 'pipe':
        return this.type(d.in, indent, owner);
      case 'array': {
        const c = checksOf(d);
        let el = this.type(d.element, indent, undefined);
        if (!/^[A-Za-z_$][\w$]*$/.test(el) && !el.startsWith('{') && !el.startsWith('[')) el = `(${el})`;
        const range =
          c.minLen !== undefined && c.maxLen !== undefined
            ? c.minLen === c.maxLen
              ? `${c.minLen}`
              : `${c.minLen}..${c.maxLen}`
            : c.maxLen !== undefined
              ? `≤${c.maxLen}`
              : c.minLen !== undefined
                ? `${c.minLen}..`
                : '';
        return `${el}[${range}]`;
      }
      case 'tuple':
        return `[${(d.items as AnyZod[]).map((i) => this.type(i, indent)).join(', ')}]`;
      case 'record':
        return `{ [key: ${this.type(d.keyType, indent)}]: ${this.type(d.valueType, indent)} }`;
      case 'union': {
        const own = d.options as AnyZod[];
        // a named union whose options are all part of this one is referenced by name
        const parts: string[] = [];
        let rest = own;
        for (const [n, other] of this.opts.named) {
          if (other === s) continue;
          const od = defOf(other);
          if (od.type !== 'union') continue;
          const oo = od.options as AnyZod[];
          if (oo.length > 1 && oo.length < rest.length && oo.every((o) => rest.includes(o))) {
            parts.push(n);
            rest = rest.filter((o) => !oo.includes(o));
          }
        }
        const opts = [...parts, ...rest.map((o) => this.type(o, indent + '  '))];
        const flat = opts.join(' | ');
        if (!d.discriminator && flat.length <= this.width) return flat;
        return opts.map((o) => `\n${indent}  | ${o}`).join('');
      }
      case 'object':
        return this.objectType(d, indent, isDecl ? owner : undefined);
      default:
        return d.type;
    }
  }

  private stringType(d: Def): string {
    const c = checksOf(d);
    let t = 'string';
    if (c.maxLen !== undefined) t += `≤${c.maxLen}`;
    if (c.regex) {
      const msg = c.regex.message && !/^Invalid/i.test(c.regex.message) ? c.regex.message : `matching ${c.regex.pattern.source}`;
      t += ` /${msg}/`;
    }
    return t;
  }

  private objectType(d: Def, indent: string, owner?: string): string {
    const shape = d.shape as Record<string, AnyZod>;
    const fields = Object.entries(shape).map(([k, v]) => {
      const vd = defOf(v);
      const optional = vd.type === 'optional' || vd.type === 'default' || vd.type === 'prefault';
      const key = IDENT.test(k) ? k : JSON.stringify(k);
      const note = owner ? this.notes[`${owner}.${k}`] : undefined;
      return { key, v, vd, optional, note };
    });
    const render = (inner: string, oneLine: boolean) =>
      fields.map((f) => {
        const t = this.type(f.v, inner);
        const dflt = f.vd.type === 'default' ? ` = ${fmtDefault(typeof f.vd.defaultValue === 'function' ? f.vd.defaultValue() : f.vd.defaultValue)}` : '';
        const note = !oneLine && f.note ? ` // ${f.note}` : '';
        return `${f.key}${f.optional ? '?' : ''}: ${t}${dflt}${oneLine ? '' : ';'}${note}`;
      });
    const hasNotes = fields.some((f) => f.note);
    if (!hasNotes) {
      const one = `{ ${render(indent, true).join('; ')} }`;
      if (one.length + indent.length <= this.width && !one.includes('\n')) return one;
    }
    const inner = indent + '  ';
    return `{\n${render(inner, false)
      .map((l) => inner + l)
      .join('\n')}\n${indent}}`;
  }
}

/** every object key and every enum / literal value (JSON-encoded, as the doc prints them) in a schema (for coverage tests) */
export function schemaVocabulary(schema: AnyZod): { keys: Set<string>; values: Set<string> } {
  const keys = new Set<string>();
  const values = new Set<string>();
  const seen = new Set<AnyZod>();
  const visit = (s: AnyZod | undefined): void => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    const d = defOf(s);
    switch (d.type) {
      case 'object':
        for (const [k, v] of Object.entries(d.shape as Record<string, AnyZod>)) {
          keys.add(k);
          visit(v);
        }
        break;
      case 'enum':
        for (const v of Object.values(d.entries as Record<string, unknown>)) values.add(JSON.stringify(v));
        break;
      case 'literal':
        for (const v of d.values as unknown[]) values.add(JSON.stringify(v));
        break;
      case 'optional':
      case 'default':
      case 'nullable':
      case 'readonly':
      case 'nonoptional':
      case 'prefault':
      case 'catch':
        visit(d.innerType);
        break;
      case 'lazy':
        visit(d.getter());
        break;
      case 'pipe':
        visit(d.in);
        break;
      case 'array':
        visit(d.element);
        break;
      case 'union':
        for (const o of d.options as AnyZod[]) visit(o);
        break;
      case 'record':
        visit(d.keyType);
        visit(d.valueType);
        break;
      case 'tuple':
        for (const o of d.items as AnyZod[]) visit(o);
        break;
    }
  };
  visit(schema);
  return { keys, values };
}

/** names of the top-level fields of every named object type (to check that `notes` keys exist) */
export function namedFields(named: [string, AnyZod][]): Set<string> {
  const out = new Set<string>();
  for (const [n, s0] of named) {
    let s = s0;
    while (defOf(s).type === 'lazy') s = defOf(s).getter();
    const d = defOf(s);
    if (d.type === 'object') for (const k of Object.keys(d.shape)) out.add(`${n}.${k}`);
  }
  return out;
}
