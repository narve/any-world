/**
 * The rooms' HTTP routes (MP3 design §2.1–§2.3; server/app.ts): health, the room list, one room,
 * create and the world upload, over an injected fetch with a timeout (5 s). Every result is one of
 *  - ok: the body, checked with the protocol's zod schemas;
 *  - unavailable: no answer (network error, timeout, 5xx, a body that does not parse, no rooms route);
 *  - outdated: the server plays another engine version (health), or refused this page's (409);
 *  - refused: the server said no, with its error code (no_room, server_full, invalid_world, rate_limit…).
 * DOM-free; never throws.
 */
import { z } from 'zod';
import { ENGINE_VERSION } from '../../net/version';
import {
  CreateRoomResponse,
  RoomInfo,
  RoomList,
  type CreateRoomRequest,
  type RoomOptions,
} from '../../net/protocol';

export const API_TIMEOUT_MS = 5000;

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'unavailable'; detail?: string }
  | { ok: false; kind: 'outdated' }
  | { ok: false; kind: 'refused'; code: string; status: number; message: string };

export type ApiFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface RoomsApiOptions {
  /** the server's origin ('' = same origin; RoomsEndpoint.api) */
  base: string;
  fetch?: ApiFetch;
  timeoutMs?: number;
  /** this page's engine version (default ENGINE_VERSION) */
  engine?: string;
}

const Health = z.object({ ok: z.boolean(), engine: z.string().optional() });
const UploadResponse = z.object({ ok: z.literal(true), worldId: z.string() });
const ErrorBody = z.object({ error: z.object({ kind: z.string().optional(), type: z.string().optional(), message: z.string().optional() }) });

export type CreateRoom = { demo: string; world?: undefined; options?: Partial<RoomOptions> } | { world: unknown; demo?: undefined; options?: Partial<RoomOptions> };

/** two engine versions disagree ('dev', an unbuilt page or server, matches anything) */
export function engineDiffers(a: string | undefined, b: string): boolean {
  return a !== undefined && a !== 'dev' && b !== 'dev' && a !== b;
}

export class RoomsApi {
  private readonly base: string;
  private readonly f: ApiFetch | null;
  private readonly timeoutMs: number;
  readonly engine: string;

  constructor(opts: RoomsApiOptions) {
    this.base = opts.base.replace(/\/+$/, '');
    this.f = opts.fetch ?? ((globalThis.fetch?.bind(globalThis) as unknown as ApiFetch | undefined) ?? null);
    this.timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;
    this.engine = opts.engine ?? ENGINE_VERSION;
  }

  /** GET /api/health: ok when the server plays this page's engine version */
  async health(): Promise<ApiResult<{ engine: string | undefined }>> {
    const r = await this.call('/api/health', Health);
    if (!r.ok) return r;
    if (engineDiffers(r.value.engine, this.engine)) return { ok: false, kind: 'outdated' };
    return { ok: true, value: { engine: r.value.engine } };
  }

  /** GET /api/rooms: the open rooms, newest first */
  listRooms(): Promise<ApiResult<RoomList>> {
    return this.call('/api/rooms', RoomList);
  }

  /** GET /api/rooms/:code (refused no_room when there is none) */
  getRoom(code: string): Promise<ApiResult<RoomInfo>> {
    return this.call(`/api/rooms/${encodeURIComponent(code)}`, RoomInfo);
  }

  /** POST /api/rooms: a new room; the token is the host seat's (connect at once) */
  createRoom(req: CreateRoom): Promise<ApiResult<CreateRoomResponse>> {
    const body: CreateRoomRequest = { engine: this.engine, ...(req.demo !== undefined ? { demo: req.demo } : { world: req.world }), ...(req.options ? { options: req.options } : {}) };
    return this.call('/api/rooms', CreateRoomResponse, body);
  }

  /** POST /api/rooms/:code/world: the host's own world for the lobby or the next run */
  uploadWorld(code: string, token: string, world: unknown): Promise<ApiResult<{ worldId: string }>> {
    return this.call(`/api/rooms/${encodeURIComponent(code)}/world`, UploadResponse, { token, world });
  }

  private async call<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<ApiResult<T>> {
    if (!this.f) return { ok: false, kind: 'unavailable', detail: 'no fetch' };
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<'timeout'>((res) => {
      timer = setTimeout(() => {
        ctl?.abort();
        res('timeout');
      }, this.timeoutMs);
    });
    try {
      const init = body === undefined ? { signal: ctl?.signal } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl?.signal };
      const res = await Promise.race([this.f(`${this.base}${path}`, init), timeout]);
      if (res === 'timeout') return { ok: false, kind: 'unavailable', detail: 'timeout' };
      const json = await Promise.race([res.json().catch(() => undefined), timeout]);
      if (json === 'timeout') return { ok: false, kind: 'unavailable', detail: 'timeout' };
      if (res.ok) {
        const p = schema.safeParse(json);
        return p.success ? { ok: true, value: p.data } : { ok: false, kind: 'unavailable', detail: 'unexpected answer' };
      }
      const err = ErrorBody.safeParse(json);
      const code = err.success ? (err.data.error.kind ?? err.data.error.type ?? '') : '';
      const message = err.success ? (err.data.error.message ?? '') : '';
      if (res.status === 409 && code === 'outdated') return { ok: false, kind: 'outdated' };
      // (a server without rooms answers 404 "Unknown API route": no rooms there)
      if (res.status >= 500 && code !== 'server_full') return { ok: false, kind: 'unavailable', detail: `HTTP ${res.status}` };
      if (!code || (res.status === 404 && code === 'bad_request')) return { ok: false, kind: 'unavailable', detail: `HTTP ${res.status}` };
      return { ok: false, kind: 'refused', code, status: res.status, message };
    } catch (e) {
      return { ok: false, kind: 'unavailable', detail: e instanceof Error ? e.message : String(e) };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
