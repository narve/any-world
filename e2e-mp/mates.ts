/**
 * Scripted teammates for the room specs (MP3 design §7): plain RoomClients over `ws` in the test
 * process, joined through the page's own origin (the dev server's /api proxy), so a spec needs one
 * browser page and still has a party. They do only what the spec tells them: say a line, type,
 * walk, stay in a menu, drop their socket. Shared helpers for the pages too.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { bfsDistances, legalActions, passability } from '../src/engine/index';
import type { GameState, PlayerAction, Pos } from '../src/engine/types';
import { RoomClient } from '../src/net/client';
import { PLAYER_COLOURS } from '../src/net/protocol';
import { computeEngineVersion } from '../server/engine-version';
import { wsFactory } from '../tools/rooms/scripted-client';
import type { RoomHandle } from '../src/client/room/flow';

export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const ENGINE = computeEngineVersion();

export async function newPage(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}, profile?: { name: string; colour: string }): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript((p) => {
    if (sessionStorage.getItem('mp-init')) return;
    sessionStorage.setItem('mp-init', '1');
    localStorage.setItem('anyworld.settings.v1', JSON.stringify({ quality: 'low', reduceMotion: true, audio: { volume: 0, muted: true } }));
    if (p) localStorage.setItem('anyworld.mp.profile', JSON.stringify(p));
  }, profile ?? null);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, page, errors };
}

export async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60_000 });
}

/**
 * Runs `fn(room handle, arg)` in the page (window.__anyworld.room); `fn` is sent as source, so it
 * may use only its arguments.
 */
export async function room<T, A = undefined>(page: Page, fn: (r: RoomHandle, arg: A) => T, arg?: A): Promise<T> {
  return page.evaluate(([src, a]) => new Function('r', 'a', `return (${src})(r, a)`)(window.__anyworld!.room, a) as T, [fn.toString(), arg] as const);
}

export const screen = (page: Page) => page.evaluate(() => document.getElementById('ui-root')?.dataset.screen ?? '');
export const layer = (page: Page) => page.evaluate(() => window.__anyworld!.ui.layer());

/** the page creates a room on `world` from the start page (the stored profile: no sheet) and returns its code */
export async function createRoom(page: Page, world = 'fixture-western'): Promise<string> {
  await page.goto('/');
  await ready(page);
  await expect(page.locator('.aw-rooms')).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });
  await page.locator(`[data-friends="${world}"]`).click();
  await expect(page.locator('.aw-lobby')).toBeVisible({ timeout: 20_000 });
  return (await page.locator('.aw-lobby-code').textContent())!.trim();
}

/** the host page starts the run and waits until it is in the game with the first card skipped */
export async function startRun(page: Page): Promise<void> {
  await page.locator('.aw-lobby-start').click();
  await expect.poll(() => screen(page), { timeout: 60_000 }).toBe('game');
  await toGameLayer(page);
}

/** Esc until the page's keys are the map's (a narration card, the onboarding card) */
export async function toGameLayer(page: Page): Promise<void> {
  for (let i = 0; i < 6 && (await layer(page)) !== 'game'; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  expect(await layer(page)).toBe('game');
}

/** the page's own player (the view's lead) */
export const myPlayer = (page: Page) =>
  page.evaluate(() => {
    const s = window.__anyworld!.controller!.session.state;
    const me = s.players[s.party[0]];
    const a = s.area.actors.find((x) => x.id === me.actorId)!;
    return { pid: s.party[0], x: a.pos.x, y: a.pos.y, turn: s.turn, actorId: a.id };
  });

/** a scripted teammate (a bare RoomClient) */
export class Mate {
  readonly client: RoomClient;

  constructor(baseURL: string, code: string, name: string, colour: string = PLAYER_COLOURS[3]) {
    const u = new URL(baseURL);
    this.client = new RoomClient({
      url: `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/api/ws`,
      socket: wsFactory(u.origin),
      engine: ENGINE,
      room: code,
      name,
      colour: colour as (typeof PLAYER_COLOURS)[number],
      backoffMs: { min: 50, max: 300 },
    });
  }

  async join(): Promise<this> {
    const w = this.client.joined();
    this.client.connect();
    await w;
    return this;
  }

  get state(): GameState | null {
    return this.client.state;
  }

  get pid(): string | null {
    return this.client.pid;
  }

  get seat(): string | null {
    return this.client.seat;
  }

  pos(): Pos | null {
    const s = this.state;
    const ps = s && this.pid ? s.players[this.pid] : null;
    return (ps && s!.area.actors.find((a) => a.id === ps.actorId)?.pos) ?? null;
  }

  /** waits until the replica is in a run with this mate's pid */
  async inRun(timeout = 30_000): Promise<void> {
    await expect.poll(() => !!(this.state && this.pid && this.state.players[this.pid]), { timeout }).toBe(true);
  }

  /** the area map's passable tiles for this mate's replica */
  private pass() {
    return passability(this.state!, { world: this.client.world! });
  }

  /**
   * Walks one step per turn toward the reachable tile farthest from `from` (BFS on the area map),
   * sending a step only after the last one resolved; stops after `steps` steps, at the tile, or
   * once `done()` says so.
   */
  async walkAwayFrom(from: () => Promise<Pos> | Pos, opts: { steps: number; done?: () => Promise<boolean>; stepMs?: number }): Promise<void> {
    const s0 = this.state!;
    const w = s0.area.map.width;
    const away = bfsDistances(w, s0.area.map.height, await from(), this.pass());
    let far = 0;
    for (let i = 1; i < away.length; i++) if (away[i] > away[far]) far = i;
    await this.walkTo({ x: far % w, y: Math.floor(far / w) }, opts);
  }

  /**
   * Walks one step per turn downhill on the BFS distances to `to` (stopping `near` steps short),
   * each step sent after the last one resolved; a wait when someone is in the way.
   */
  async walkTo(to: Pos, opts: { steps: number; near?: number; done?: () => Promise<boolean>; stepMs?: number }): Promise<void> {
    const s0 = this.state!;
    const w = s0.area.map.width;
    const dist = bfsDistances(w, s0.area.map.height, to, this.pass());
    const dirs: Record<string, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] };
    for (let i = 0; i < opts.steps; i++) {
      if (opts.done && (await opts.done())) return;
      const s = this.state!;
      const me = this.pos();
      if (!me || !this.pid || s.area.index !== s0.area.index) return;
      let bestD = dist[me.y * w + me.x];
      if (bestD <= (opts.near ?? 0)) return;
      const moves = legalActions(s, { playerId: this.pid, world: this.client.world! }).filter((a): a is Extract<PlayerAction, { type: 'move' }> => a.type === 'move');
      let best: PlayerAction | null = null;
      for (const m of moves) {
        const [dx, dy] = dirs[m.dir];
        const d = dist[(me.y + dy) * w + (me.x + dx)];
        if (d >= 0 && d < bestD) [best, bestD] = [m, d];
      }
      await this.act(best ?? { type: 'wait' });
      await new Promise((r) => setTimeout(r, opts.stepMs ?? 30));
    }
  }

  /**
   * Sends one turn action and waits until an entry came. An open choice (a GM offer, a perk) is
   * answered first; a refused action (held in place, say) is replaced by a wait.
   */
  async act(a: PlayerAction): Promise<void> {
    const legal = legalActions(this.state!, { playerId: this.pid!, world: this.client.world! });
    const perk = legal.find((x) => x.type === 'choose_perk');
    const options = legal.filter((x) => x.type === 'choose_option');
    if (perk || (options.length && !legal.some((x) => x.type === 'wait'))) await this.send(perk ?? options[options.length - 1]);
    if (!(await this.send(a)) && a.type !== 'wait') await this.send({ type: 'wait' });
  }

  /** one input; true when an entry came, false when the server refused it */
  private send(a: PlayerAction): Promise<boolean> {
    const n = this.client.n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (off(), reject(new Error(`no entry for ${JSON.stringify(a)} in 10 s`))), 10_000);
      const off = this.client.on((e) => {
        if (e.t === 'entries' && this.client.n > n) (clearTimeout(timer), off(), resolve(true));
        else if (e.t === 'message' && e.msg.t === 'refusal') (clearTimeout(timer), off(), resolve(false));
      });
      this.client.input([a], a.type === 'wait' ? 'wait' : 'decide');
    });
  }

  leave(): void {
    this.client.leave();
  }

  stop(): void {
    if (this.client.status !== 'stopped') this.client.stop();
  }
}
