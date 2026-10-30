/**
 * Room WebSockets on the existing node:http server (MP2 design §2, §9). Only `/api/ws` upgrades
 * (other paths: 400, the socket destroyed); the Origin must be in ALLOWED_ORIGINS, or, only when
 * that list is empty, the request's own http(s)://<Host> (the page this server serves, or the Vite
 * proxy in dev); a missing Origin is refused (403). Per IP (clientIpFrom, so TRUST_PROXY applies):
 * upgrades per minute and open sockets; open sockets in all. An error handler is on the socket
 * before handleUpgrade, so a reset during the handshake cannot throw.
 *
 * Per connection: frames over 16 KB are refused by ws itself (maxPayload, close 1009), deflate is
 * off, a send that leaves more than 4 MB buffered closes the socket (1009), token buckets per type
 * and overall (limits.ts; a drop gets a non-fatal `error rate`, 200 drops a minute close with
 * 1008), 50 invalid messages close with 1008, ws pings detect dead sockets (two missed pongs
 * terminate). The first message must be a `hello` within timing.helloTimeoutMs (else 4000), checked
 * in this order: the engine version (peekHello, so an old page always gets `refused outdated` with
 * reload), full parsing, then the room and token (RoomManager.hello).
 */
import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { CLOSE, LIMITS, parseClientMsg, peekHello, REFUSED_CLOSE, type ServerMsg } from '../../src/net/protocol';
import { RateLimiter } from '../rate-limit';
import { refused, type Conn, type Room } from './room';
import type { RoomManager } from './manager';
import { ConnBuckets, REPLACED_TERMINATE_MS, roomLimits, type RoomLimits } from './limits';

export const WS_PATH = '/api/ws';

export interface RoomSocketsOptions {
  manager: RoomManager;
  /** ALLOWED_ORIGINS; empty = the request's own host only */
  allowedOrigins: ReadonlySet<string>;
  /** the rate-limit key of a request (app.ts clientIpFrom with TRUST_PROXY) */
  clientIp: (req: IncomingMessage) => string;
  limits?: Partial<RoomLimits>;
  log?: (line: string) => void;
  /** clock for the per-IP limiters (tests) */
  now?: () => number;
}

export interface RoomSockets {
  /** open sockets */
  readonly size: number;
  /** stops accepting, waits up to `graceMs` for sockets to close, then terminates the rest */
  close(graceMs?: number): Promise<void>;
}

/** the minimal ws surface a Conn needs (a fake in tests) */
export interface WsLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/**
 * A Conn over a ws socket: messages are JSON text frames; a send that leaves more than
 * `bufferBytes` queued (a client that stopped reading) closes the socket with 1009 and drops it.
 */
export function wsConn(ws: WsLike, bufferBytes: number): Conn {
  const sendText = (text: string) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(text);
    if (ws.bufferedAmount > bufferBytes) {
      ws.close(CLOSE.tooBig, 'too slow');
      // the close frame would wait behind the backlog: drop the socket now
      ws.terminate();
    }
  };
  return {
    send(msg: ServerMsg) {
      if (ws.readyState !== WebSocket.OPEN) return;
      sendText(JSON.stringify(msg));
    },
    sendText,
    close(code: number, reason?: string) {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
      ws.close(code, reason);
      // a replaced socket is often half-open (a phone changed network): it must not hold its per-IP
      // slot until the close handshake times out (MP5); a live old tab still gets the close frame
      if (code === CLOSE.replaced) {
        const t = setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
        }, REPLACED_TERMINATE_MS);
        t.unref?.();
      }
    },
  };
}

/** the Origin rule (§9): listed origins only; when the list is empty, the request's own host too */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!origin) return false;
  if (allowed.has(origin)) return true;
  if (allowed.size > 0 || !host) return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function reject(socket: Duplex, status: number, headers: Record<string, string> = {}): void {
  try {
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
  } catch {
    // already gone
  }
  socket.destroy();
}

interface Client {
  ws: WebSocket;
  ip: string;
  conn: Conn;
  room: Room | null;
  buckets: ConnBuckets;
  invalid: number;
  missedPongs: number;
  helloTimer: ReturnType<typeof setTimeout> | null;
}

export function attachRoomSockets(server: Server, opts: RoomSocketsOptions): RoomSockets {
  const limits = roomLimits(opts.limits);
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((l: string) => console.log(l));
  const manager = opts.manager;
  const upgrades = new RateLimiter({ perMinute: limits.upgradesPerMin, burst: Math.max(1, limits.upgradesPerMin), now });
  const perIp = new Map<string, number>();
  const clients = new Set<Client>();
  let closing = false;
  /** close() waiting for the last socket */
  let drained: (() => void) | null = null;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: LIMITS.frameBytes, clientTracking: false });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://local').pathname;
    } catch {
      return reject(socket, 400);
    }
    if (path !== WS_PATH || closing) return reject(socket, closing ? 503 : 400);
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!originAllowed(origin, req.headers.host, opts.allowedOrigins)) return reject(socket, 403);
    const ip = opts.clientIp(req);
    const rl = upgrades.take(ip);
    if (!rl.allowed) return reject(socket, 429, { 'retry-after': String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))) });
    if (clients.size >= limits.socketsTotal) return reject(socket, 503);
    if ((perIp.get(ip) ?? 0) >= limits.socketsPerIp) return reject(socket, 429);
    // counted now, so parallel handshakes cannot pass the limits together
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    let counted = true;
    const uncount = () => {
      if (!counted) return;
      counted = false;
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left > 0) perIp.set(ip, left);
      else perIp.delete(ip);
    };
    socket.once('close', uncount);
    try {
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip, uncount));
    } catch {
      uncount();
      socket.destroy();
    }
  };

  const onConnection = (ws: WebSocket, ip: string, uncount: () => void): void => {
    const c: Client = { ws, ip, conn: wsConn(ws, limits.socketBufferBytes), room: null, buckets: new ConnBuckets(now()), invalid: 0, missedPongs: 0, helloTimer: null };
    clients.add(c);
    if (closing) {
      ws.terminate();
      return;
    }
    c.helloTimer = setTimeout(() => {
      c.helloTimer = null;
      if (!c.room) c.conn.close(CLOSE.helloTimeout, 'hello timeout');
    }, manager.timing.helloTimeoutMs);
    c.helloTimer.unref?.();
    ws.on('error', () => {
      // a protocol error (an oversized frame…): ws closes the socket itself
    });
    ws.on('pong', () => {
      c.missedPongs = 0;
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      // (rooms guard their own work; this keeps any other throw from ending the process and every room)
      try {
        onMessage(c, data, isBinary);
      } catch (e) {
        log(`[rooms] ${c.ip}: message failed: ${e instanceof Error ? e.message : String(e)}`);
        c.ws.terminate();
      }
    });
    ws.on('close', () => {
      clients.delete(c);
      uncount();
      if (clients.size === 0) drained?.();
      if (c.helloTimer) clearTimeout(c.helloTimer);
      c.helloTimer = null;
      const room = c.room;
      c.room = null;
      if (room) room.disconnect(c.conn);
    });
  };

  const invalid = (c: Client, why: string): void => {
    c.invalid++;
    if (c.invalid >= LIMITS.invalidMax) {
      log(`[rooms] ${c.ip}: ${c.invalid} invalid messages, closing`);
      c.conn.close(CLOSE.policy, 'invalid messages');
      return;
    }
    c.conn.send({ t: 'error', code: 'invalid', message: why });
  };

  const onMessage = (c: Client, data: RawData, isBinary: boolean): void => {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    const t = now();
    if (isBinary) {
      if (!c.buckets.take(null, t)) return dropped(c);
      return invalid(c, 'binary frames are not used');
    }
    const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8');
    if (!c.room) {
      if (!c.buckets.take('hello', t)) return dropped(c);
      const peek = peekHello(text);
      if (!peek) return invalid(c, 'the first message must be hello');
      if (peek.engine !== manager.engineVersion) {
        const r = { ...refused('outdated', 'This page is out of date. Reload it to play.'), reload: true as const };
        c.conn.send(r);
        return c.conn.close(REFUSED_CLOSE.outdated, 'outdated');
      }
      const msg = parseClientMsg(text);
      if (!msg || msg.t !== 'hello') return invalid(c, 'invalid hello');
      if (c.helloTimer) clearTimeout(c.helloTimer);
      c.helloTimer = null;
      // refusals are sent and the socket closed by the manager
      c.room = manager.hello(c.conn, msg);
      return;
    }
    const msg = parseClientMsg(text);
    if (!c.buckets.take(msg?.t ?? null, t)) return dropped(c);
    if (!msg) return invalid(c, 'invalid message');
    if (c.room.closed) return;
    c.room.message(c.conn, msg);
  };

  const dropped = (c: Client): void => {
    if (c.buckets.tooManyDrops) {
      log(`[rooms] ${c.ip}: too many messages, closing`);
      return c.conn.close(CLOSE.policy, 'rate');
    }
    c.conn.send({ t: 'error', code: 'rate', message: 'too many messages; slow down' });
  };

  const pinger = setInterval(() => {
    for (const c of clients) {
      if (c.missedPongs >= 2) {
        c.ws.terminate();
        continue;
      }
      c.missedPongs++;
      try {
        c.ws.ping();
      } catch {
        // closing
      }
    }
  }, Math.max(10, limits.pingMs));
  pinger.unref?.();

  server.on('upgrade', onUpgrade);

  return {
    get size() {
      return clients.size;
    },
    async close(graceMs = 0) {
      closing = true;
      clearInterval(pinger);
      server.off('upgrade', onUpgrade);
      if (graceMs > 0 && clients.size) {
        await new Promise<void>((res) => {
          const end = setTimeout(() => res(), graceMs);
          drained = () => {
            clearTimeout(end);
            res();
          };
        });
        drained = null;
      }
      // closeAllConnections does not reach upgraded sockets
      for (const c of clients) c.ws.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
    },
  };
}
