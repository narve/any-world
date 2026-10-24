/**
 * Shared prompt helpers: language names and the language instruction (DESIGN §7b), weirdness
 * bands, a tiny seeded PRNG for "surprise me" draws, and JSON-only output rules.
 * Browser-safe and deterministic.
 */
import type { Difficulty } from '../../schema/gm';

const KNOWN_LANGUAGES: Record<string, string> = {
  en: 'English',
  nb: 'Norwegian Bokmål',
  nn: 'Norwegian Nynorsk',
  no: 'Norwegian (Bokmål)',
  sv: 'Swedish',
  da: 'Danish',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  fi: 'Finnish',
  pl: 'Polish',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
};

/** normalise a BCP-47 tag ("NB-no" → "nb-NO"); "" / invalid → "en" */
export function normaliseLanguage(tag: string | undefined | null): string {
  const t = (tag ?? '').trim().replace(/_/g, '-');
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(t) || t.length > 12) return 'en';
  const [lang, ...rest] = t.split('-');
  return [lang!.toLowerCase(), ...rest.map((r) => (r.length === 2 ? r.toUpperCase() : r))].join('-');
}

/** English name of a language tag, e.g. "nb" → "Norwegian Bokmål" */
export function languageName(tag: string): string {
  const t = normaliseLanguage(tag);
  const base = t.split('-')[0]!;
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'language' });
    const name = dn.of(t);
    if (name && name.toLowerCase() !== t.toLowerCase()) return name;
  } catch {
    /* Intl.DisplayNames missing: use the table */
  }
  return KNOWN_LANGUAGES[t] ?? KNOWN_LANGUAGES[base] ?? t;
}

/**
 * The language rule every content prompt carries: player-facing text in the run's language, ids and
 * the JSON structure in ASCII English.
 */
export function languageInstruction(tag: string): string {
  const t = normaliseLanguage(tag);
  const name = languageName(t);
  const lines = [
    `LANGUAGE: write ALL player-facing text in ${name} (language tag "${t}"): names, titles, descriptions, dialogue, narration, labels, vocabulary words, goal texts, rule texts.`,
    'Ids, JSON keys, enum values, dice strings, colours and other machine fields stay exactly as specified (ASCII, English). These instructions are in English; your player-facing text must not be.',
  ];
  if (t.startsWith('nb') || t === 'no') {
    lines.push('Use natural, modern bokmål (not nynorsk, not Danish), with Norwegian letters æ, ø and å where they belong.');
    lines.push('Address the player as "du" everywhere (goal, win and loss texts, narration, dialogue), unless the world\'s voice is deliberately formal; then use "De" consistently in every text. Keep game-mechanical words short: Norwegian compounds make labels long, and the length limits still apply.');
  }
  if (t !== 'en') lines.push('Do not translate proper nouns that are deliberately foreign, but do not fall back to English for ordinary words.');
  return lines.join('\n');
}

/** words for the weirdness slider (0 familiar … 1 unhinged) */
export function weirdnessBand(w: number): { label: string; guidance: string } {
  const x = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.5;
  if (x < 0.2)
    return {
      label: 'grounded',
      guidance: 'Stay close to the familiar: a recognisable genre and setting, played straight. Surprise through specific detail and an unexpected angle, not through strangeness.',
    };
  if (x < 0.45)
    return {
      label: 'a little odd',
      guidance: 'Mostly familiar, with one or two strange elements that the world takes seriously (an odd rule, a peculiar place, an uncanny character).',
    };
  if (x < 0.7)
    return {
      label: 'strange',
      guidance: 'Clearly unusual: bend the genre, mix eras or scales, let at least one area be non-realistic (no gravity, no sky, abstract or organic spaces). Keep it readable and coherent.',
    };
  if (x < 0.9)
    return {
      label: 'surreal',
      guidance: 'Dream-logic welcome: impossible geography, abstract or living architecture, beings that are concepts, colours or sounds. Use the non-realistic generators and backdrops. Rules should still be learnable.',
    };
  return {
    label: 'unhinged',
    guidance: 'Go as far as you can while staying playable: abstract art, inner worlds, mathematics, emotions as places. Nothing has to be Earth-like or human. Make the strangeness consistent so the player can learn it.',
  };
}

/** what each difficulty asks of the content (the engine itself scales hostile hp / damage) */
export function difficultyGuidance(d: Difficulty): string {
  switch (d) {
    case 'gentle':
      return 'gentle: a forgiving run for players who want the story. Generous healing, telegraphed dangers, a merciful rule (permadeathMercy or regeneration) is welcome; harsh rules need a counterweight.';
    case 'hard':
      return 'hard: tense and dangerous. Fewer healing items, smarter enemy mixes (kiters, packs, ambushers), at least one demanding rule variant.';
    case 'brutal':
      return 'brutal: a run most players will lose. Scarce healing, punishing rule variants, dangerous bosses with abilities. Still never unwinnable or unfair: every death must be avoidable in hindsight.';
    case 'normal':
    default:
      return 'normal: fair but deadly. A careful player wins about half the time.';
  }
}

/** mulberry32: small seeded PRNG for deterministic draws */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** clamp helper for prompt inputs */
export function clamp01(x: number | undefined, fallback = 0.5): number {
  return typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : fallback;
}

/** the closing output rule of every JSON prompt */
export const JSON_ONLY =
  'OUTPUT: reply with exactly one JSON object and nothing else: no prose before or after, no markdown fences, no comments. Use double quotes, no trailing commas.';
