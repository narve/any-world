/**
 * The room protocol (MP2 design §2): zod schemas and types for every message between a room server
 * and its clients, the HTTP bodies of /api/rooms, and the limits both sides use. Shared like src/llm:
 * the server imports it through tsx, Vite bundles it into the client, both validate with the same
 * schemas. Imports only the engine, the schema and zod (no node: modules, no DOM).
 *
 * Text frames of JSON, one message each, discriminated by `t`. Every incoming client message goes
 * through parseClientMsg; outgoing server messages are validated by clients (parseServerMsg). A
 * `hello` is first read with peekHello, which looks only at `engine`, so a page built from another
 * protocol or engine still gets a clear `refused outdated` instead of a validation failure.
 */
import { z } from 'zod';
import { Difficulty, GmAction, GmHook } from '../schema/gm';
import { jsonDepth, MAX_JSON_DEPTH } from '../schema/json-depth';
import { MAX_PARTY_SIZE, TOTAL_SLOTS } from '../engine/index';
import type { PlayerAction, TurnInput } from '../engine/types';

/** the protocol version (hello.v); the engine version (version.ts) is checked before it */
export const PROTOCOL = 1;

export const LIMITS = {
  /** largest incoming WebSocket frame (ws maxPayload); worlds are uploaded over HTTP */
  frameBytes: 16 * 1024,
  /** POST /api/rooms and /api/rooms/:code/world bodies */
  roomBodyBytes: 1024 * 1024,
  /** a socket whose bufferedAmount exceeds this is closed (1009) */
  socketBufferBytes: 4 * 1024 * 1024,
  engineMax: 64,
  /** names: code points after control characters are stripped and the ends trimmed */
  nameMax: 24,
  /** chat lines: code points after cleaning (longer → error chat_long) */
  chatMax: 200,
  /** a raw chat text longer than this is not a message at all (invalid) */
  chatRawMax: 2000,
  chatHistory: 100,
  /** actions in one `input` (free actions and at most one turn action) */
  actionsPerInput: 4,
  /** an input more than this many engine turns behind state.turn is dropped (error stale) */
  staleTurns: 3,
  /** clients report hashState after every entry with n % hashEvery === 0 */
  hashEvery: 10,
  deadlineMs: { min: 1000, max: 5000, default: 2000 },
  maxPlayers: { min: 2, max: MAX_PARTY_SIZE, default: 8 },
  maxRooms: 10,
  /** invalid messages before a socket is closed (1008) */
  invalidMax: 50,
  /** rate-dropped messages in a minute before a socket is closed (1008) */
  rateDropsMax: 200,
  /** token buckets per connection: messages per second and burst */
  rates: {
    overall: { perSec: 40, burst: 40 },
    input: { perSec: 20, burst: 40 },
    presence: { perSec: 4, burst: 4 },
    typing: { perSec: 4, burst: 4 },
    chat: { perSec: 1, burst: 1 },
    hash: { perSec: 2, burst: 2 },
    applied: { perSec: 2, burst: 2 },
  },
} as const;

/** the 12 player colours (one per seat at most; a taken colour is replaced by the first free one) */
export const PLAYER_COLOURS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff',
] as const;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

// C0 and C1 controls, and the bidi overrides and isolates (they can reorder the rest of a line)
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** a name or chat text as shown: control characters removed, ends trimmed */
export function cleanText(s: string): string {
  return s.replace(CONTROL, '').trim();
}

/** code points, not UTF-16 units (an emoji counts once) */
export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** a chat text as the room keeps it, or null when it is empty or over LIMITS.chatMax (chat_long) */
export function cleanChat(text: string): string | null {
  const t = cleanText(text);
  const n = codePoints(t);
  return n >= 1 && n <= LIMITS.chatMax ? t : null;
}

/** room code: 4 characters without 0/O/1/I/L */
export const Code = z.string().regex(/^[2-9A-HJ-NP-Z]{4}$/);
/** seat token: 128 bits, base64url */
export const Token = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const Name = z
  .string()
  .max(200)
  .transform(cleanText)
  .refine((s) => s.length > 0 && codePoints(s) <= LIMITS.nameMax, { message: `1–${LIMITS.nameMax} characters` });
export const Colour = z.enum(PLAYER_COLOURS);
export const Intent = z.enum(['decide', 'travel', 'wait']);
export type Intent = z.infer<typeof Intent>;
/** the client's view state; a hidden tab is 'menu' */
export const Presence = z.enum(['playing', 'menu']);
export type Presence = z.infer<typeof Presence>;
export const PlayerIdSchema = z.string().regex(/^p\d{1,3}$/);
export const SeatId = z.string().regex(/^s\d{1,4}$/);
/** a demo world: a file id in content/worlds (without .json) */
export const DemoId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const EngineVersion = z.string().min(1).max(LIMITS.engineMax);
const Count = z.number().int().min(0).max(1e9);
const ActorRef = z.string().min(1).max(32);
const Slot = z.number().int().min(0).max(TOTAL_SLOTS - 1);
const PosSchema = z.object({ x: z.number().int().min(0).max(1023), y: z.number().int().min(0).max(1023) });

/** mirrors the engine's PlayerAction (two-way type check below), with bounded strings and integers */
export const PlayerActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), dir: z.enum(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) }),
  z.object({ type: z.literal('attack'), targetId: ActorRef }),
  z.object({ type: z.literal('wait') }),
  z.object({ type: z.literal('use'), slot: Slot, target: PosSchema.optional() }),
  z.object({ type: z.literal('equip'), slot: Slot }),
  z.object({ type: z.literal('unequip'), slot: Slot }),
  z.object({ type: z.literal('move_item'), from: Slot, to: Slot }),
  z.object({ type: z.literal('drop'), slot: Slot }),
  z.object({ type: z.literal('pickup') }),
  z.object({ type: z.literal('transition') }),
  z.object({ type: z.literal('talk'), targetId: ActorRef }),
  z.object({ type: z.literal('persuade'), targetId: ActorRef }),
  z.object({ type: z.literal('search') }),
  z.object({ type: z.literal('toggle_sneak') }),
  z.object({ type: z.literal('choose_perk'), perkId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('choose_option'), index: z.number().int().min(0).max(15) }),
  z.object({ type: z.literal('interact'), pos: PosSchema }),
]);

export const TurnInputSchema = z.object({
  playerId: PlayerIdSchema,
  actions: z.array(PlayerActionSchema).max(LIMITS.actionsPerInput).optional(),
  busy: z.boolean().optional(),
});

/** true when A and B are the same type (strict: an optional field on one side only counts too) */
export type SameType<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// a new engine action (or field) breaks the build here instead of being dropped as invalid
const actionsMatch: SameType<z.infer<typeof PlayerActionSchema>, PlayerAction> = true;
const inputsMatch: SameType<z.infer<typeof TurnInputSchema>, TurnInput> = true;
void actionsMatch;
void inputsMatch;

// ---------------------------------------------------------------------------
// Log entries (applied by src/net/log.ts applyEntry; n counts entries from 0 per run)
// ---------------------------------------------------------------------------

const entry = { n: Count, run: Count };
export const LogEntrySchema = z.discriminatedUnion('k', [
  z.object({ ...entry, k: z.literal('turn'), inputs: z.array(TurnInputSchema).max(MAX_PARTY_SIZE), advance: z.boolean() }),
  z.object({ ...entry, k: z.literal('gm'), hook: GmHook, actions: z.array(GmAction).max(6) }),
  z.object({ ...entry, k: z.literal('join'), seat: SeatId, name: Name, pid: PlayerIdSchema, near: PlayerIdSchema }),
  z.object({ ...entry, k: z.literal('away'), pid: PlayerIdSchema }),
  z.object({ ...entry, k: z.literal('back'), pid: PlayerIdSchema }),
  z.object({ ...entry, k: z.literal('leave'), pid: PlayerIdSchema }),
  z.object({ ...entry, k: z.literal('return'), pid: PlayerIdSchema, near: PlayerIdSchema }),
]);
export type LogEntry = z.infer<typeof LogEntrySchema>;
export type LogEntryKind = LogEntry['k'];
/** an entry before the room numbers it (n, run) */
export type LogEntryBody = LogEntry extends infer E ? (E extends LogEntry ? Omit<E, 'n' | 'run'> : never) : never;

// ---------------------------------------------------------------------------
// Rooms, roster, chat
// ---------------------------------------------------------------------------

export const Phase = z.enum(['lobby', 'playing', 'ended']);
export type Phase = z.infer<typeof Phase>;

export const RoomOptions = z.object({
  maxPlayers: z.number().int().min(LIMITS.maxPlayers.min).max(LIMITS.maxPlayers.max),
  deadlineMs: z.number().int().min(LIMITS.deadlineMs.min).max(LIMITS.deadlineMs.max),
  difficulty: Difficulty,
});
export type RoomOptions = z.infer<typeof RoomOptions>;

export const RoomInfo = z.object({
  code: Code,
  world: z.object({ id: z.string().max(80), title: z.string().max(200), genre: z.string().max(200), language: z.string().max(35) }),
  players: z.number().int().min(0).max(MAX_PARTY_SIZE),
  maxPlayers: z.number().int().min(1).max(MAX_PARTY_SIZE),
  phase: Phase,
  joinable: z.boolean(),
});
export type RoomInfo = z.infer<typeof RoomInfo>;

export const SeatPresence = z.enum(['active', 'busy', 'menu', 'idle', 'off', 'gone']);
export type SeatPresence = z.infer<typeof SeatPresence>;

export const RosterEntry = z.object({
  seat: SeatId,
  pid: PlayerIdSchema.nullable(),
  name: z.string().max(100),
  colour: Colour,
  host: z.boolean(),
  connected: z.boolean(),
  presence: SeatPresence,
  /** ms timestamp of the last presence change */
  since: z.number(),
});
export type RosterEntry = z.infer<typeof RosterEntry>;

export const ChatLine = z.object({
  id: Count,
  seat: SeatId,
  name: z.string().max(100),
  colour: Colour,
  text: z.string().max(LIMITS.chatRawMax),
  at: z.number(),
});
export type ChatLine = z.infer<typeof ChatLine>;

/** serialize() of a GameState after n entries (n = the next entry's n) */
export const Snapshot = z.object({ n: Count, state: z.string().max(16 * 1024 * 1024) });
export type Snapshot = z.infer<typeof Snapshot>;

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

export const ClientMsg = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    v: z.literal(PROTOCOL),
    engine: EngineVersion,
    room: Code,
    token: Token.optional(),
    name: Name,
    colour: Colour,
    /** how many entries of `run` this client has applied, i.e. the next n it expects (reconnect) */
    lastN: Count.optional(),
    run: Count.optional(),
  }),
  z.object({
    t: z.literal('input'),
    /** the area index and state.turn the client decided on (older ones are dropped: error stale) */
    area: z.number().int().min(0).max(99),
    turn: Count,
    actions: z.array(PlayerActionSchema).max(LIMITS.actionsPerInput),
    busy: z.boolean().optional(),
    intent: Intent,
  }),
  z.object({ t: z.literal('presence'), state: Presence }),
  z.object({ t: z.literal('typing'), on: z.boolean() }),
  z.object({ t: z.literal('chat'), text: z.string().max(LIMITS.chatRawMax) }),
  /** hashState after n entries (every LIMITS.hashEvery) */
  z.object({ t: z.literal('hash'), n: Count, h: z.string().regex(/^[0-9a-f]{16}$/) }),
  /** an area-change entry is applied locally: n = the entries applied with it (ends the area hold) */
  z.object({ t: z.literal('applied'), n: Count }),
  /** host only, lobby or ended phase */
  z.object({ t: z.literal('start'), demo: DemoId.optional() }),
  /** host only */
  z.object({ t: z.literal('options'), deadlineMs: RoomOptions.shape.deadlineMs.optional(), maxPlayers: RoomOptions.shape.maxPlayers.optional() }),
  z.object({ t: z.literal('leave') }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;
export type ClientMsgType = ClientMsg['t'];
export type Hello = Extract<ClientMsg, { t: 'hello' }>;
export type InputMsg = Extract<ClientMsg, { t: 'input' }>;

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export const ErrorCode = z.enum(['rate', 'invalid', 'not_host', 'chat_rate', 'chat_long', 'bad_phase', 'stale']);
export type ErrorCode = z.infer<typeof ErrorCode>;
/** a refused hello; the socket is then closed with REFUSED_CLOSE[code] */
export const RefusedCode = z.enum(['outdated', 'no_room', 'room_full', 'room_closed', 'bad_token', 'server_full']);
export type RefusedCode = z.infer<typeof RefusedCode>;
export const ClosedReason = z.enum(['server_updated', 'idle', 'empty', 'error']);
export type ClosedReason = z.infer<typeof ClosedReason>;

export const ServerMsg = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('welcome'),
    room: RoomInfo,
    you: z.object({ seat: SeatId, pid: PlayerIdSchema.nullable(), token: Token, host: z.boolean() }),
    roster: z.array(RosterEntry).max(MAX_PARTY_SIZE),
    phase: Phase,
    run: Count,
    options: RoomOptions,
    /** the world spec, omitted when hello.run matches (the client has it); checked against worldId */
    world: z.unknown().optional(),
    worldId: z.string().max(80),
    snapshot: Snapshot.optional(),
    /** the entries from n = hello.lastN on, when the server still has them */
    entries: z.array(LogEntrySchema).optional(),
    chat: z.array(ChatLine).max(LIMITS.chatHistory),
  }),
  z.object({ t: z.literal('entries'), run: Count, es: z.array(LogEntrySchema).min(1) }),
  /** a full state for a client whose hash disagreed */
  z.object({ t: z.literal('snapshot'), run: Count, n: Count, state: Snapshot.shape.state }),
  /** a new run (play again) */
  z.object({ t: z.literal('run'), run: Count, world: z.unknown().optional(), worldId: z.string().max(80), snapshot: Snapshot }),
  z.object({ t: z.literal('roster'), seats: z.array(RosterEntry).max(MAX_PARTY_SIZE) }),
  z.object({ t: z.literal('clock'), n: Count, acted: z.array(PlayerIdSchema).max(MAX_PARTY_SIZE), waiting: z.array(PlayerIdSchema).max(MAX_PARTY_SIZE), deadlineInMs: Count.optional() }),
  z.object({ t: z.literal('chat'), line: ChatLine }),
  z.object({ t: z.literal('typing'), seat: SeatId, on: z.boolean() }),
  /** to the acting seat only: its actions the engine refused (nothing was appended) */
  z.object({ t: z.literal('refusal'), reasons: z.array(z.object({ action: PlayerActionSchema, reason: z.string().max(64), detail: z.string().max(400).optional() })).max(LIMITS.actionsPerInput) }),
  /** non-fatal */
  z.object({ t: z.literal('error'), code: ErrorCode, message: z.string().max(400) }),
  z.object({ t: z.literal('refused'), code: RefusedCode, message: z.string().max(400), reload: z.literal(true).optional(), reason: ClosedReason.optional() }),
  z.object({ t: z.literal('closed'), reason: ClosedReason, message: z.string().max(400) }),
  /** graceful shutdown: reconnect with backoff */
  z.object({ t: z.literal('bye'), reason: z.literal('restart') }),
]);
export type ServerMsg = z.infer<typeof ServerMsg>;
export type ServerMsgType = ServerMsg['t'];
export type Welcome = Extract<ServerMsg, { t: 'welcome' }>;
export type Refused = Extract<ServerMsg, { t: 'refused' }>;
export type Closed = Extract<ServerMsg, { t: 'closed' }>;

/** WebSocket close codes */
export const CLOSE = {
  helloTimeout: 4000,
  replaced: 4007,
  closed: 4010,
  policy: 1008,
  tooBig: 1009,
} as const;
export const REFUSED_CLOSE: Record<RefusedCode, number> = {
  outdated: 4001,
  no_room: 4002,
  room_full: 4003,
  room_closed: 4004,
  bad_token: 4005,
  server_full: 4006,
};

// ---------------------------------------------------------------------------
// HTTP bodies (/api/rooms)
// ---------------------------------------------------------------------------

export const CreateRoomRequest = z
  .object({
    engine: EngineVersion,
    demo: DemoId.optional(),
    /** an uploaded world: validated with parseWorld (strict keys) by the server */
    world: z.unknown().optional(),
    options: RoomOptions.partial().optional(),
  })
  .refine((b) => (b.demo === undefined) !== (b.world === undefined), { message: 'give either demo or world' });
export type CreateRoomRequest = z.infer<typeof CreateRoomRequest>;
export const CreateRoomResponse = z.object({ code: Code, token: Token });
export type CreateRoomResponse = z.infer<typeof CreateRoomResponse>;
export const RoomList = z.object({ rooms: z.array(RoomInfo), max: z.number().int() });
export type RoomList = z.infer<typeof RoomList>;
/** POST /api/rooms/:code/world: a new world for "play again" (host only, lobby or ended phase) */
export const WorldUploadRequest = z.object({ token: Token, world: z.unknown() });
export type WorldUploadRequest = z.infer<typeof WorldUploadRequest>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** JSON text (or an already parsed value) → a value, or undefined when it is not JSON or nests too deep */
function decode(raw: unknown, maxChars?: number): unknown {
  let v = raw;
  if (typeof raw === 'string') {
    if (maxChars !== undefined && raw.length > maxChars) return undefined;
    try {
      v = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (jsonDepth(v, MAX_JSON_DEPTH) > MAX_JSON_DEPTH) return undefined;
  return v;
}

/** a client message (a frame's text or a parsed value), or null when it is invalid or unknown */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  const v = decode(raw, LIMITS.frameBytes);
  if (v === undefined) return null;
  const r = ClientMsg.safeParse(v);
  return r.success ? r.data : null;
}

/** a server message, or null when it is invalid (a client bug or a newer server: reconnect) */
export function parseServerMsg(raw: unknown): ServerMsg | null {
  const v = decode(raw);
  if (v === undefined) return null;
  const r = ServerMsg.safeParse(v);
  return r.success ? r.data : null;
}

/**
 * Reads only `{ t: 'hello', engine: string }` of a first message, leniently (any other fields, any
 * protocol version), so the engine version is answered before anything else is validated.
 */
export function peekHello(raw: unknown): { engine: string } | null {
  const v = decode(raw, LIMITS.frameBytes);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.t !== 'hello' || typeof o.engine !== 'string') return null;
  return { engine: o.engine.slice(0, LIMITS.engineMax) };
}
