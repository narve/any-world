/**
 * What a player is told when a room refuses or closes their connection (MP2 design §2): i18n keys of
 * the client catalogs (src/client/i18n en.ts / nb.ts, net.*) for the MP3 toast. `reload`: the page
 * itself is outdated, so the toast offers a reload button (never an automatic reload: Pages and the
 * server deploy at different times, and an automatic reload would loop while Pages serves the old build).
 */
import type { Closed, ClosedReason, Refused, RefusedCode } from './protocol';

export type NetNoticeKey =
  | 'net.outdated'
  | 'net.serverUpdated'
  | 'net.noRoom'
  | 'net.roomFull'
  | 'net.roomClosed'
  | 'net.badToken'
  | 'net.serverFull'
  | 'net.closedIdle'
  | 'net.closedEmpty'
  | 'net.closedError';

export interface NetNotice {
  key: NetNoticeKey;
  reload: boolean;
}

const REFUSED_KEYS: Record<RefusedCode, NetNoticeKey> = {
  outdated: 'net.outdated',
  no_room: 'net.noRoom',
  room_full: 'net.roomFull',
  room_closed: 'net.roomClosed',
  bad_token: 'net.badToken',
  server_full: 'net.serverFull',
};

const CLOSED_KEYS: Record<ClosedReason, NetNoticeKey> = {
  server_updated: 'net.serverUpdated',
  idle: 'net.closedIdle',
  empty: 'net.closedEmpty',
  error: 'net.closedError',
};

/** every key noticeFor can return (the catalogs must have them all: tests/net/messages.test.ts) */
export const NET_NOTICE_KEYS: readonly NetNoticeKey[] = [...new Set([...Object.values(REFUSED_KEYS), ...Object.values(CLOSED_KEYS)])];

/** the toast for a `refused` or `closed` message */
export function noticeFor(msg: Pick<Refused, 't' | 'code' | 'reload' | 'reason'> | Pick<Closed, 't' | 'reason'>): NetNotice {
  if (msg.t === 'closed') return { key: CLOSED_KEYS[msg.reason] ?? 'net.closedError', reload: false };
  // a room closed by a deploy: the server is newer, but this page may be current already (no reload)
  if (msg.code === 'room_closed' && msg.reason === 'server_updated') return { key: 'net.serverUpdated', reload: false };
  return { key: REFUSED_KEYS[msg.code] ?? 'net.roomClosed', reload: msg.code === 'outdated' || msg.reload === true };
}
