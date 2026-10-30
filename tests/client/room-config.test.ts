/**
 * MP3 D1: where rooms live per build (src/client/room/config.ts, design §2.1, §6): the backend build
 * on the page's origin, a static build with ANYWORLD_SERVER_URL on that server (ws derived from
 * http(s)), the offline static build without rooms; the share link is the page's own origin.
 */
import { describe, it, expect } from 'vitest';
import { pageBuild, roomLink, roomsEndpoint } from '../../src/client/room/config';

describe('roomsEndpoint', () => {
  it('the backend build: same origin, ws or wss from the page', () => {
    expect(roomsEndpoint({ server: '', transport: 'backend' }, { protocol: 'https:', host: 'any.dv8.no' })).toEqual({ api: '', ws: 'wss://any.dv8.no/api/ws' });
    expect(roomsEndpoint({ server: '', transport: 'backend' }, { protocol: 'http:', host: 'localhost:5173' })).toEqual({ api: '', ws: 'ws://localhost:5173/api/ws' });
  });

  it('a static build with a server URL: that server, wss from https', () => {
    const loc = { protocol: 'https:', host: 'any.dv8.no' };
    expect(roomsEndpoint({ server: 'https://any-game.dv8.no', transport: 'direct' }, loc)).toEqual({ api: 'https://any-game.dv8.no', ws: 'wss://any-game.dv8.no/api/ws' });
    expect(roomsEndpoint({ server: 'http://192.168.1.5:8787/', transport: 'direct' }, loc)).toEqual({ api: 'http://192.168.1.5:8787', ws: 'ws://192.168.1.5:8787/api/ws' });
    expect(roomsEndpoint({ server: 'https://h.example/game', transport: 'backend' }, loc)).toEqual({ api: 'https://h.example/game', ws: 'wss://h.example/game/api/ws' });
  });

  it('the static build without a server (the offline demo): no rooms; nonsense URLs neither', () => {
    expect(roomsEndpoint({ server: '', transport: 'direct' }, { protocol: 'https:', host: 'x' })).toBeNull();
    expect(roomsEndpoint({ server: 'not a url', transport: 'direct' }, { protocol: 'https:', host: 'x' })).toBeNull();
    expect(roomsEndpoint({ server: 'ftp://x.example', transport: 'direct' }, { protocol: 'https:', host: 'x' })).toBeNull();
  });

  it('outside a build (tests) the page is a backend build; the share link keeps the page origin and path', () => {
    expect(pageBuild()).toEqual({ server: '', transport: 'backend' });
    expect(roomLink({ origin: 'https://any.dv8.no', pathname: '/' }, 'K7QX')).toBe('https://any.dv8.no/?room=K7QX');
    expect(roomLink({ origin: 'https://narve.github.io', pathname: '/anyworld/index.html' }, 'K7QX')).toBe('https://narve.github.io/anyworld/index.html?room=K7QX');
  });
});
