/**
 * The curated prompt library (content/prompts.json) as start-screen inspiration. A `worldId` is
 * kept only when that world is bundled and valid, so "Play demo" never points at a missing world.
 */
import libraryJson from '../../content/prompts.json';
import { baseLanguage, parsePromptLibrary, type PromptEntry } from '../schema/prompts';
import { localizePromptLibrary, translatedWorlds } from './i18n/library';
import type { InspirationPrompt } from './ui/viewmodel';

let cache: PromptEntry[] | null = null;

/** the library's valid entries (bad ones are skipped with a warning) */
export function promptLibrary(): PromptEntry[] {
  if (cache) return cache;
  const r = parsePromptLibrary(libraryJson);
  for (const e of r.errors) console.warn('[anyworld] prompt library:', e);
  cache = r.prompts;
  return cache;
}

/** inspiration cards: the library entries, linked to the bundled worlds that exist */
export function inspirationPrompts(entries: readonly PromptEntry[], bundledIds: ReadonlySet<string>): InspirationPrompt[] {
  return entries.map((p) => ({
    prompt: p.prompt,
    genre: p.genre,
    tags: p.tags,
    teaser: p.teaser,
    language: p.language,
    ...(p.worldId && bundledIds.has(p.worldId) ? { worldId: p.worldId } : {}),
  }));
}

/**
 * The library as the start screen shows it in UI language `lang`: one card per translation group,
 * in that language where a translation exists (DESIGN §7b), linked to bundled worlds only.
 */
export function localizedInspiration(entries: readonly PromptEntry[], bundledIds: ReadonlySet<string>, lang: string): InspirationPrompt[] {
  return inspirationPrompts(localizePromptLibrary(entries, lang), bundledIds);
}

/**
 * The demo worlds to list for UI language `lang`. A recorded world and its translated copy are one
 * world: the copy in `lang` is listed when there is one, else the original — never both.
 */
export function demoWorldsFor<T extends { id: string }>(worlds: readonly T[], entries: readonly PromptEntry[], lang: string): T[] {
  const want = baseLanguage(lang);
  const ids = new Set(worlds.map((w) => w.id));
  const copies = translatedWorlds(entries);
  const hidden = new Set<string>();
  for (const [copy, { of, language }] of copies) {
    if (!ids.has(copy) || !ids.has(of)) continue;
    hidden.add(baseLanguage(language) === want ? of : copy);
  }
  return worlds.filter((w) => !hidden.has(w.id));
}
