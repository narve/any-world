/**
 * UI strings of the audio module (music panel). The texts live in the shared i18n catalogs
 * (src/client/i18n/<lang>.ts, keys `audio.panel.*` and `audio.mood.*`), so adding a language means
 * adding a catalog file and nothing else (DESIGN §7b), and the catalog CI checks cover them.
 */
import en from '../i18n/en';
import { availableLanguages, catalog, t, type MessageKey, type MessageParams } from '../i18n';

export type AudioMessageKey = Extract<MessageKey, `audio.${string}`>;

const AUDIO_KEYS = (Object.keys(en) as MessageKey[]).filter((k): k is AudioMessageKey => k.startsWith('audio.'));

function pick(messages: Record<string, string> | undefined): Record<AudioMessageKey, string> {
  const out = {} as Record<AudioMessageKey, string>;
  for (const k of AUDIO_KEYS) out[k] = messages?.[k] ?? en[k];
  return out;
}

/** the audio strings of every catalog, by language (falls back to English per key, like t()) */
export const AUDIO_MESSAGES: Record<string, Record<AudioMessageKey, string>> = Object.fromEntries(
  availableLanguages().map(({ code }) => [code, pick(catalog(code))]),
);

/** an audio UI string in the current language */
export function at(key: AudioMessageKey, params?: MessageParams): string {
  return t(key, params);
}
