/**
 * The players' chat in the room GM's context (MP4 design §3.1). Pure: picks the recent lines of a
 * room's chat and cleans them again for the prompt, where each one is quoted as a JSON string (the
 * prompt layer does that), so no line can close the block, fake a header or start a new message.
 * The chat is untrusted input: it never reaches a prompt as instructions, only as quoted data.
 */
import type { GmContextChatLine } from '../engine/gm-context';

/** lines from this far back (ms) */
export const GM_CHAT_WINDOW_MS = 5 * 60_000;
/** newest lines kept */
export const GM_CHAT_LINES = 12;
/** characters of chat text in all (oldest lines dropped first) */
export const GM_CHAT_CHARS = 1500;
/** characters per line after cleaning */
export const GM_CHAT_LINE_MAX = 200;
/** characters of a seat name */
const NAME_MAX = 40;

/** the parts of a room chat line the GM reads (protocol ChatLine) */
export interface ChatSourceLine {
  name: string;
  text: string;
  /** wall-clock ms */
  at: number;
  /** a map ping: never quoted */
  ping?: unknown;
}

// every control character (C0, C1, line and paragraph separators) and the bidi overrides and isolates
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** a chat text or seat name for the prompt: controls and newlines become spaces, runs of space one, clipped */
export function cleanChatQuote(s: string, max = GM_CHAT_LINE_MAX): string {
  const t = s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const cps = [...t];
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : t;
}

/** a line with words in it (not a ping, not a lone emote or punctuation) */
function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * The chat lines for the GM: lines with words from the last 5 minutes, newest 12, at most 1500
 * characters in all (oldest dropped first), oldest first. `new` marks lines said after the GM last
 * answered the chat (`lastAnswerAt`, wall-clock ms; absent = every line is new).
 */
export function chatQuotes(lines: readonly ChatSourceLine[], now: number, lastAnswerAt?: number): GmContextChatLine[] {
  const picked: GmContextChatLine[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0 && picked.length < GM_CHAT_LINES; i--) {
    const l = lines[i]!;
    if (now - l.at > GM_CHAT_WINDOW_MS) break;
    if (l.ping || !hasWords(l.text)) continue;
    const said = cleanChatQuote(l.text);
    if (!said) continue;
    chars += said.length;
    if (chars > GM_CHAT_CHARS) break;
    const q: GmContextChatLine = { from: cleanChatQuote(l.name, NAME_MAX) || '?', said, ageS: Math.max(0, Math.round((now - l.at) / 1000)) };
    if (lastAnswerAt === undefined || l.at > lastAnswerAt) q.new = true;
    picked.push(q);
  }
  return picked.reverse();
}
