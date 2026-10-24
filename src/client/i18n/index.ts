/// <reference types="vite/client" />
/**
 * UI message catalogs (DESIGN §7b). Every player-facing UI string comes from a catalog:
 *
 *   t('hud.turn', { n: 42 })            → "Turn 42"
 *   tx(msg.key, msg.params, msg.text)  → a dynamic key (engine log lines) with a fallback
 *
 * Catalogs are the files `src/client/i18n/<lang>.ts` (en.ts is complete and the fallback for any
 * key another catalog lacks). Adding a language means adding one such file — it is picked up here
 * automatically — whose default export maps the same keys to translated ICU-subset messages
 * (see message-format.ts), plus an optional `export const meta = { name: 'Norsk bokmål' }`.
 *
 * Genre words never live in a catalog: they come from the world's vocabulary as params.
 *
 * Language state: the player's choice (localStorage) → else the browser language ('nb' for any
 * Norwegian: nb/no/nn) → else 'en'. Outside a browser (tests, node) the default is 'en'.
 */
import en from './en';
import { formatMessage, type MessageParams } from './message-format';

export { formatMessage, messageArgs, parseMessage, type MessageParams } from './message-format';

export type Messages = Record<string, string>;
export type MessageKey = keyof typeof en;

export interface LanguageInfo {
  code: string;
  /** the language's own name ("English", "Norsk bokmål") */
  name: string;
}

interface CatalogModule {
  default?: unknown;
  meta?: { name?: string };
}

const CATALOG_FILE = /\/([a-z]{2,3}(?:-[A-Za-z0-9]+)?)\.ts$/;

const catalogs = new Map<string, Messages>([['en', en]]);
const names = new Map<string, string>([['en', 'English']]);

function loadCatalogs(mods: Record<string, unknown>): void {
  for (const [path, mod] of Object.entries(mods)) {
    const m = CATALOG_FILE.exec(path);
    if (!m) continue;
    const code = m[1];
    const cm = mod as CatalogModule;
    const msgs = cm?.default;
    if (!msgs || typeof msgs !== 'object' || Array.isArray(msgs)) continue;
    catalogs.set(code, msgs as Messages);
    if (cm.meta?.name) names.set(code, cm.meta.name);
    else if (!names.has(code)) names.set(code, code);
  }
}

try {
  // every catalog file next to this one (en.ts is imported statically above as the fallback)
  loadCatalogs(import.meta.glob('./*.ts', { eager: true }) as Record<string, unknown>);
} catch {
  /* not running under vite: only the static English catalog */
}

/** register (or replace) a catalog at run time — tests and tools */
export function registerCatalog(code: string, messages: Messages, name?: string): void {
  catalogs.set(normalizeLanguage(code), messages);
  names.set(normalizeLanguage(code), name ?? names.get(code) ?? code);
}

/** the catalog for `code`, if one exists */
export function catalog(code: string): Messages | undefined {
  return catalogs.get(code);
}

/** languages that have a catalog, English first */
export function availableLanguages(): LanguageInfo[] {
  return [...catalogs.keys()]
    .sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)))
    .map((code) => ({ code, name: names.get(code) ?? code }));
}

// ---------------------------------------------------------------------------
// language state
// ---------------------------------------------------------------------------

const LANG_KEY = 'anyworld.lang.v1';
const NORWEGIAN = new Set(['nb', 'no', 'nn']);

/** BCP-47 tag → the catalog code we use ('nb-NO', 'no', 'nn' → 'nb'; 'en-GB' → 'en') */
export function normalizeLanguage(tag: string): string {
  const base = String(tag || '').trim().toLowerCase().split(/[-_]/)[0];
  if (NORWEGIAN.has(base)) return 'nb';
  return base || 'en';
}

/**
 * The default UI language for a browser's language list: Norwegian of any kind → 'nb', English →
 * 'en', otherwise the first language that has a catalog, else 'en'.
 */
export function detectLanguage(langs: readonly string[] | undefined | null): string {
  for (const l of langs ?? []) {
    const code = normalizeLanguage(l);
    if (code === 'nb' || code === 'en') return code;
    if (catalogs.has(code)) return code;
  }
  return 'en';
}

let current: string | null = null;
const listeners = new Set<(lang: string) => void>();

function store(): Storage | null {
  try {
    return typeof document === 'undefined' ? null : (globalThis.localStorage ?? null);
  } catch {
    return null;
  }
}

function initialLanguage(): string {
  try {
    const saved = store()?.getItem(LANG_KEY);
    if (saved) return normalizeLanguage(saved);
  } catch {
    /* storage blocked */
  }
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return 'en';
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return detectLanguage(langs);
}

/** the current UI language code ('en', 'nb', …) */
export function getLanguage(): string {
  if (current === null) current = initialLanguage();
  return current;
}

/**
 * Switch the UI language (persisted per browser). Listeners are told; the UI rebuilds its text.
 * `persist: false` changes it for this page only (tests).
 */
export function setLanguage(code: string, opts: { persist?: boolean } = {}): void {
  const next = normalizeLanguage(code);
  const changed = next !== getLanguage();
  current = next;
  if (opts.persist !== false) {
    try {
      store()?.setItem(LANG_KEY, next);
    } catch {
      /* ignore */
    }
  }
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (changed) for (const fn of [...listeners]) fn(next);
}

/** called after every language change; returns an unsubscribe function */
export function onLanguageChange(fn: (lang: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

/** the raw template for a key in the current language (English fallback), or undefined */
export function template(key: string, lang = getLanguage()): string | undefined {
  return catalogs.get(lang)?.[key] ?? en[key as MessageKey];
}

/** does any catalog (current or English) define this key? */
export function hasKey(key: string): boolean {
  return template(key) !== undefined;
}

/** a UI string by catalog key */
export function t(key: MessageKey, params?: MessageParams): string {
  const lang = getLanguage();
  const tpl = template(key, lang);
  return tpl === undefined ? key : formatMessage(tpl, params, lang);
}

/**
 * A UI string for a key computed at run time (engine log keys, enum-derived keys). When no catalog
 * has the key, `fallback` is returned as is (for engine lines: their English text), else the key.
 */
export function tx(key: string, params?: MessageParams, fallback?: string): string {
  const lang = getLanguage();
  const tpl = template(key, lang);
  if (tpl === undefined) return fallback ?? key;
  return formatMessage(tpl, params, lang);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** "a, b and c" / "a, b or c" in the current language */
export function listJoin(items: readonly string[], kind: 'and' | 'or' = 'and'): string {
  const xs = items.filter((x) => x);
  if (xs.length <= 1) return xs[0] ?? '';
  try {
    return new Intl.ListFormat(getLanguage(), { style: 'long', type: kind === 'and' ? 'conjunction' : 'disjunction' }).format(xs);
  } catch {
    const word = t(kind === 'and' ? 'common.and' : 'common.or');
    return `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`;
  }
}

/** first letter upper-cased (locale-aware) */
export function capitalizeFirst(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase(getLanguage()) + s.slice(1) : s;
}
