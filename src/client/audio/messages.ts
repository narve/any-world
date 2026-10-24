/**
 * UI strings of the audio module (music panel). Looked up through the shared i18n catalogs first
 * (`tx`), so a catalog that defines an `audio.*` key wins; otherwise these built-in English and
 * Norwegian bokmål texts are used. The catalogs may adopt the keys below verbatim
 * (AUDIO_MESSAGES.en / .nb).
 */
import { formatMessage, getLanguage, normalizeLanguage, tx, type MessageParams } from '../i18n';

const en = {
  'audio.panel.title': 'Music',
  'audio.panel.mood': 'Mood: {mood}',
  'audio.panel.ambience': 'Generated ambience',
  'audio.panel.volume': 'Volume',
  'audio.panel.mute': 'Mute',
  'audio.panel.unmute': 'Unmute',
  'audio.panel.search': 'Search SoundCloud',
  'audio.panel.suggestions': 'Suggested listening',
  'audio.panel.nothing': 'This world has no music suggestions.',
  'audio.panel.newTab': '{label} (opens in a new tab)',
  'audio.panel.offline': 'You are offline. The links work once you are back online.',
  'audio.panel.embedOff': 'The SoundCloud player is off. Turn it on in settings to play music here.',
  'audio.panel.paste': 'SoundCloud track or playlist link',
  'audio.panel.play': 'Play',
  'audio.panel.close': 'Close player',
  'audio.panel.badUrl': 'That is not a SoundCloud link.',
  'audio.panel.playerTitle': 'SoundCloud player',
  'audio.mood.explore': 'exploring',
  'audio.mood.tense': 'tense',
  'audio.mood.calm': 'calm',
  'audio.mood.eerie': 'eerie',
  'audio.mood.boss': 'showdown',
  'audio.mood.upbeat': 'upbeat',
} as const;

export type AudioMessageKey = keyof typeof en;

const nb: Record<AudioMessageKey, string> = {
  'audio.panel.title': 'Musikk',
  'audio.panel.mood': 'Stemning: {mood}',
  'audio.panel.ambience': 'Generert stemningsmusikk',
  'audio.panel.volume': 'Volum',
  'audio.panel.mute': 'Lyd av',
  'audio.panel.unmute': 'Lyd på',
  'audio.panel.search': 'Søk på SoundCloud',
  'audio.panel.suggestions': 'Forslag til lytting',
  'audio.panel.nothing': 'Denne verdenen har ingen musikkforslag.',
  'audio.panel.newTab': '{label} (åpnes i ny fane)',
  'audio.panel.offline': 'Du er frakoblet. Lenkene virker når du er på nett igjen.',
  'audio.panel.embedOff': 'SoundCloud-spilleren er slått av. Slå den på i innstillingene for å spille musikk her.',
  'audio.panel.paste': 'Lenke til et SoundCloud-spor eller en spilleliste',
  'audio.panel.play': 'Spill',
  'audio.panel.close': 'Lukk spilleren',
  'audio.panel.badUrl': 'Det er ikke en SoundCloud-lenke.',
  'audio.panel.playerTitle': 'SoundCloud-spiller',
  'audio.mood.explore': 'utforskende',
  'audio.mood.tense': 'anspent',
  'audio.mood.calm': 'rolig',
  'audio.mood.eerie': 'uhyggelig',
  'audio.mood.boss': 'oppgjør',
  'audio.mood.upbeat': 'lystig',
};

export const AUDIO_MESSAGES: Record<string, Record<AudioMessageKey, string>> = { en, nb };

/** an audio UI string in the current language */
export function at(key: AudioMessageKey, params?: MessageParams): string {
  const lang = normalizeLanguage(getLanguage());
  const local = AUDIO_MESSAGES[lang]?.[key] ?? en[key];
  return tx(key, params, formatMessage(local, params, lang));
}
