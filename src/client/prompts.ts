/**
 * The curated prompt library (content/prompts.json) as start-screen inspiration. A `worldId` is
 * kept only when that world is bundled and valid, so "Play demo" never points at a missing world.
 */
import libraryJson from '../../content/prompts.json';
import { parsePromptLibrary, type PromptEntry } from '../schema/prompts';
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
