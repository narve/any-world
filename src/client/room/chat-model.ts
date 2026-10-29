/**
 * The room chat as the client keeps it (MP3 design §4), DOM-free: the history (at most
 * LIMITS.chatHistory lines, merged by ChatLine.id so a reconnect repeats nothing), one speech bubble
 * per speaker (the newest line, for a time that grows with its length), who is typing (cleared on
 * their next line or after the server's typing expiry), the unread count for the phone's chat
 * button, and the send throttle that mirrors the server's 1/s chat bucket (shared by text, emotes
 * and pings). Lengths are counted in code points with the protocol's codePoints, as cleanChat does
 * (❤️ is two).
 */
import { codePoints, LIMITS, type ChatLine, type PingKind } from '../../net/protocol';

/** the one-tap emotes; a line that is exactly one of them shows as a large frameless bubble */
export const EMOTES = ['👍', '😂', '😮', '❤️', '👋', '❓'] as const;

export const CHAT_TIMING = {
  /** a bubble shows 4 s + 50 ms per character, at most 10 s */
  bubbleBaseMs: 4000,
  bubblePerCharMs: 50,
  bubbleMaxMs: 10_000,
  /** a ping marker shows 8 s */
  pingMs: 8000,
  /** a typing seat without a refresh stops typing after this (the server's typing expiry) */
  typingMs: 8000,
  /** one line a second (the server's chat bucket) */
  sendGapMs: 1000 / LIMITS.rates.chat.perSec,
  /** the length counter shows from this many code points */
  counterFrom: 160,
} as const;

export interface Bubble {
  /** the line's id */
  id: number;
  seat: string;
  text: string;
  /** the text is exactly one emote */
  emote: boolean;
  ping?: PingKind;
  until: number;
}

export interface DraftInfo {
  /** code points */
  count: number;
  left: number;
  over: boolean;
  /** show the counter (from CHAT_TIMING.counterFrom) */
  counter: boolean;
}

export function isEmote(text: string): boolean {
  return (EMOTES as readonly string[]).includes(text);
}

/** how long a bubble for `line` stays */
export function bubbleMs(line: Pick<ChatLine, 'text' | 'ping'>): number {
  if (line.ping) return CHAT_TIMING.pingMs;
  return Math.min(CHAT_TIMING.bubbleMaxMs, CHAT_TIMING.bubbleBaseMs + CHAT_TIMING.bubblePerCharMs * codePoints(line.text));
}

export class ChatModel {
  /** the history, oldest first, by id */
  readonly lines: ChatLine[] = [];
  /** lines since the chat sheet was last open (phones); own lines do not count */
  unread = 0;
  /** this client's seat (its own lines are not unread) */
  self: string | null;
  private sheetOpen = false;
  private ids = new Set<number>();
  private typingUntil = new Map<string, number>();
  private bubbleBy = new Map<string, Bubble>();
  private lastSentAt = -Infinity;
  /**
   * a line, emote or ping was sent and its echo has not come back yet: a `rate` error now (the
   * socket's message bucket dropped something) counts as a chat error, since it may have been this
   */
  awaitingEcho = false;

  constructor(opts: { self?: string | null; lines?: readonly ChatLine[] } = {}) {
    this.self = opts.self ?? null;
    if (opts.lines) this.merge(opts.lines);
  }

  /** a live line (a chat frame): kept, the speaker's bubble, typing ended, unread counted; false for a line already kept */
  push(line: ChatLine, now: number): boolean {
    if (!this.add(line)) return false;
    if (line.seat === this.self) this.awaitingEcho = false;
    this.typingUntil.delete(line.seat);
    if (line.seat !== this.self && !this.sheetOpen) this.unread++;
    const prev = this.bubbleBy.get(line.seat);
    // (an older line arriving late never replaces a newer bubble)
    if (!prev || prev.id < line.id) {
      this.bubbleBy.set(line.seat, { id: line.id, seat: line.seat, text: line.text, emote: !line.ping && isEmote(line.text), ...(line.ping ? { ping: line.ping.kind } : {}), until: now + bubbleMs(line) });
    }
    return true;
  }

  /** a welcome's history (join or reconnect): lines not kept yet are added quietly, with no bubbles and no unread count */
  merge(lines: readonly ChatLine[]): number {
    let n = 0;
    for (const l of lines) if (this.add(l)) n++;
    return n;
  }

  private add(line: ChatLine): boolean {
    if (this.ids.has(line.id)) return false;
    this.ids.add(line.id);
    let i = this.lines.length;
    while (i > 0 && this.lines[i - 1].id > line.id) i--;
    this.lines.splice(i, 0, line);
    while (this.lines.length > LIMITS.chatHistory) this.ids.delete(this.lines.shift()!.id);
    return true;
  }

  /** a typing frame */
  setTyping(seat: string, on: boolean, now: number): void {
    if (on) this.typingUntil.set(seat, now + CHAT_TIMING.typingMs);
    else this.typingUntil.delete(seat);
  }

  /** seats typing now (not this client), expired ones dropped */
  typing(now: number): Set<string> {
    for (const [seat, until] of this.typingUntil) if (until <= now) this.typingUntil.delete(seat);
    const out = new Set(this.typingUntil.keys());
    if (this.self) out.delete(this.self);
    return out;
  }

  /** one bubble per speaker: the newest line, while it lasts */
  bubbles(now: number): Bubble[] {
    const out: Bubble[] = [];
    for (const [seat, b] of this.bubbleBy) {
      if (b.until <= now) this.bubbleBy.delete(seat);
      else out.push(b);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  /** whether a line, emote or ping may go now (the server allows one a second) */
  canSend(now: number): { ok: true } | { ok: false; waitMs: number } {
    const wait = this.lastSentAt + CHAT_TIMING.sendGapMs - now;
    return wait > 0 ? { ok: false, waitMs: Math.ceil(wait) } : { ok: true };
  }

  /** a line, emote or ping was sent at `now` */
  noteSent(now: number): void {
    this.lastSentAt = now;
    this.awaitingEcho = true;
  }

  /** the draft's length against LIMITS.chatMax, in code points */
  draft(text: string): DraftInfo {
    const count = codePoints(text);
    return { count, left: LIMITS.chatMax - count, over: count > LIMITS.chatMax, counter: count >= CHAT_TIMING.counterFrom };
  }

  /** the phone chat sheet opened (unread cleared, and stays cleared while open) or closed */
  setSheetOpen(open: boolean): void {
    this.sheetOpen = open;
    if (open) this.unread = 0;
  }

  /** the newest `n` lines */
  recent(n: number): ChatLine[] {
    return this.lines.slice(-n);
  }
}
