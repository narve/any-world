/**
 * The prompt library in the UI language (DESIGN §7b: "inspiration prompts are shown in the UI
 * language"). Pure; no DOM, no catalog lookups.
 *
 * An entry is shown in language L when it is written in L, or when it carries `translations[L]`
 * (prompt, teaser, optional genre and an optional translated recorded world). Entries that are
 * translated copies of each other (`translationOf`) form one group, and only one entry per group
 * is shown: the first that reads in L, else the original.
 */
import { baseLanguage, type PromptEntry } from '../../schema/prompts';

/** the entry as it reads in `lang` (unchanged when it has no translation into it) */
export function localizePrompt(entry: PromptEntry, lang: string): PromptEntry {
  const want = baseLanguage(lang);
  if (baseLanguage(entry.language) === want) return entry;
  const tr = entry.translations?.[want];
  if (!tr) return entry;
  return {
    ...entry,
    prompt: tr.prompt,
    teaser: tr.teaser,
    genre: tr.genre ?? entry.genre,
    language: want,
    ...(tr.worldId ? { worldId: tr.worldId } : {}),
  };
}

/**
 * The library for a UI language: every entry localized where possible, one entry per translation
 * group, original order kept (a group sits where its first member was).
 */
export function localizePromptLibrary(entries: readonly PromptEntry[], lang: string): PromptEntry[] {
  const want = baseLanguage(lang);
  const ids = new Set(entries.map((e) => e.id));
  const groupOf = (e: PromptEntry): string => (e.translationOf && ids.has(e.translationOf) ? e.translationOf : e.id);
  const groups = new Map<string, PromptEntry[]>();
  for (const e of entries) {
    const g = groupOf(e);
    const list = groups.get(g);
    const loc = localizePrompt(e, want);
    if (list) list.push(loc);
    else groups.set(g, [loc]);
  }
  const out: PromptEntry[] = [];
  for (const [g, list] of groups) {
    const pick = list.find((e) => baseLanguage(e.language) === want) ?? list.find((e) => e.id === g) ?? list[0]!;
    out.push(pick);
  }
  return out;
}

/** ids of recorded worlds that are translated copies, with the world they translate */
export function translatedWorlds(entries: readonly PromptEntry[]): Map<string, { of: string; language: string }> {
  const out = new Map<string, { of: string; language: string }>();
  for (const e of entries) {
    if (!e.worldId) continue;
    for (const [language, tr] of Object.entries(e.translations ?? {})) {
      if (tr.worldId) out.set(tr.worldId, { of: e.worldId, language });
    }
  }
  return out;
}
