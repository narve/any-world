/**
 * Where rooms live (MP3 design §2.1, §6), decided once at boot from the build constants main.ts
 * reads too (__ANYWORLD_SERVER__, __ANYWORLD_DEFAULT_TRANSPORT__):
 *  - the backend build (served by the server, or Vite's dev server proxying /api) → the page's origin;
 *  - a static build with ANYWORLD_SERVER_URL → that server (it lists the page in ALLOWED_ORIGINS);
 *  - a static build without it (the offline GitHub Pages demo) → null: no rooms at all.
 * DOM-free: the page's location is passed in.
 */

export interface RoomsBuild {
  /** ANYWORLD_SERVER_URL of the build ('' = none) */
  server: string;
  /** the build's default LLM transport: 'direct' is the static build */
  transport: 'direct' | 'backend';
}

export interface RoomsEndpoint {
  /** prefix of the HTTP routes ('' = same origin; else the server's origin) */
  api: string;
  /** the room socket, ws(s)://host/api/ws */
  ws: string;
}

/** the room endpoints of this build, or null when it has no server */
export function roomsEndpoint(build: RoomsBuild, loc: { protocol: string; host: string }): RoomsEndpoint | null {
  const server = build.server.trim().replace(/\/+$/, '');
  if (server) {
    let u: URL;
    try {
      u = new URL(server);
    } catch {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const path = u.pathname.replace(/\/+$/, '');
    return { api: server, ws: `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}${path}/api/ws` };
  }
  if (build.transport === 'direct') return null;
  return { api: '', ws: `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/api/ws` };
}

/** this page's build constants (the defines of vite.config.ts; absent in tests: a backend build) */
export function pageBuild(): RoomsBuild {
  return {
    server: typeof __ANYWORLD_SERVER__ !== 'undefined' ? __ANYWORLD_SERVER__ : '',
    transport: typeof __ANYWORLD_DEFAULT_TRANSPORT__ !== 'undefined' ? __ANYWORLD_DEFAULT_TRANSPORT__ : 'backend',
  };
}

/** the share link of a room: the page's own origin and path (on Pages, not the server's) */
export function roomLink(loc: { origin: string; pathname: string }, code: string): string {
  return `${loc.origin}${loc.pathname}?room=${encodeURIComponent(code)}`;
}
