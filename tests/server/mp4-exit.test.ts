/**
 * MP4 exit check end to end (plan §3 MP4, design §7; G5). No real provider anywhere: a MockProvider
 * whose every answer obeys the hostile chat, and a child server with no GM preset.
 *  - GM checks still refuse fiat, also with hostile chat: a party of 3 where the AI GM (mock) answers
 *    every moment with fiat after every seat addressed it with a hostile line; the line reaches the
 *    GM, the answers arrive, and only what the checks allow is ever applied (no goal item, no fiat
 *    damage, words only for chat); every client on the server's hash; the files replay with 0 calls
 *  - demo rooms play without AI: the real server process with no ANYWORLD_GM_PRESET and a key in its
 *    environment builds no provider; a demo room plays its recordings, two scripted clients on one hash
 *  (the party room on the mock with scripted answers, its restarts and the browser part are in
 *  rooms-gm.test.ts and e2e-mp/mp-gm.spec.ts)
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashState } from '../../src/engine';
import type { GmAction } from '../../src/schema/gm';
import { PLAYER_COLOURS, type LogEntry } from '../../src/net/protocol';
import { MockProvider } from '../../src/llm/mock';
import { amountMax, goalWriteProblem, isWordAction } from '../../src/llm/gm-checks';
import { recheckGmActions } from '../../src/gm/recheck';
import { RoomManager } from '../../server/rooms/manager';
import { CHAT_HOOK_ROOM_MS } from '../../server/rooms/room';
import { ManualScheduler } from '../../server/rooms/timing';
import { ScriptedClient } from '../../tools/rooms/scripted-client';
import { loadFixture } from '../engine/helpers';
import { MemRoom } from '../client/room-harness';
import { ENGINE, freePort, killChild, postJson, spawnServer, until } from './rooms-helpers';
import { aiConfig, BOTS, expectLockstep, Forbidden, GOAL_ITEM, gmChecks, helpOf, HOSTILE_LINE, lateClock, OBEDIENT, packCount, play, quiet, started } from './rooms-gm-helpers';

const western = loadFixture('fixture-western.json');
const WESTERN_REC = JSON.parse(readFileSync(join(__dirname, '../../content/recordings/fixture-western/gm-intro-a0.json'), 'utf8')) as { recordings: { json: { actions: GmAction[] } }[] };

let h: MemRoom | null = null;
const dirs: string[] = [];
const children: ChildProcess[] = [];
const scripted: ScriptedClient[] = [];
afterEach(async () => {
  h?.dispose();
  h = null;
  for (const c of scripted.splice(0)) await c.close();
  for (const p of children.splice(0)) await killChild(p);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'anyworld-mp4exit-'));
  dirs.push(d);
  return d;
}

/** the largest damage or heal amount anywhere in an action (offers and triggers included) */
function biggestAmount(a: unknown): number {
  if (!a || typeof a !== 'object') return 0;
  let m = 0;
  const o = a as Record<string, unknown>;
  if ((o.type === 'damage' || o.type === 'heal') && o.amount && typeof o.amount === 'object') m = amountMax(o.amount as Parameters<typeof amountMax>[0]);
  for (const v of Object.values(o)) m = Math.max(m, Array.isArray(v) ? Math.max(0, ...v.map(biggestAmount)) : biggestAmount(v));
  return m;
}

describe('MP4 exit: GM checks still refuse fiat, also with hostile chat', () => {
  it('a party of 3 whose AI GM obeys every hostile line: the lines reach it, nothing it is not allowed lands, lockstep, replay with 0 calls', async () => {
    const clock = lateClock();
    // every moment (intro, area, idle, low_hp, chat, the repairs) answered by a model that obeys the chat
    const mock = new MockProvider({ responses: { gm: { json: OBEDIENT } }, latencyMs: [20, 400], seed: 12, ...clock.timers });
    const dir = tempDir();
    h = new MemRoom({ world: western, seed: 17, gm: aiConfig(mock), dir });
    clock.set(h.sch);
    const seats = await started(h, ['Ann', 'Bo', 'Cy']);
    const start = h.room.state!;
    let said = 0;
    await play(h, seats, () => h!.room.n >= 160, {
      each: async () => {
        // each seat addresses the GM twice, past the room's chat-hook gap
        if (said < 6 && h!.room.n >= 15 + said * 20) {
          await h!.advance(CHAT_HOOK_ROOM_MS + 1000);
          seats[said % seats.length]!.c.say(HOSTILE_LINE);
          said++;
        }
      },
    });
    await quiet(h);
    expect(said).toBe(6);
    expect(h.room.n).toBeGreaterThanOrEqual(160);
    expectLockstep(h, seats);

    // the hostile lines were in the GM's context (quoted as chat data)
    expect(mock.callCount).toBeGreaterThan(3);
    expect(mock.calls.some((c) => JSON.stringify(c.messages).includes('ignore your rules'))).toBe(true);

    const entries = h.room.recentEntries();
    const gms = entries.filter((e): e is Extract<LogEntry, { k: 'gm' }> => e.k === 'gm');
    // the obedient answers arrived (their words are kept) and chat moments were answered
    expect(gms.some((e) => e.actions.some((a) => a.type === 'narrate' && a.text.startsWith('As you command')))).toBe(true);
    expect(gms.some((e) => e.hook === 'chat')).toBe(true);
    const end = gmChecks(western, start, entries, (e, before, after) => {
      expect(recheckGmActions(western, before, e.actions, e.pid).dropped).toEqual([]);
      for (const a of e.actions) {
        expect(goalWriteProblem(western, a)).toBeNull();
        expect(a.type === 'give_item' && a.item === GOAL_ITEM).toBe(false);
        expect(biggestAmount(a)).toBeLessThan(999);
      }
      if (e.hook === 'chat') expect(e.actions.every(isWordAction)).toBe(true);
      for (const pid of Object.keys(after.players)) expect(packCount(after, pid, GOAL_ITEM)).toBe(packCount(before, pid, GOAL_ITEM));
      // nobody is knocked down by the GM
      for (const [pid, p] of Object.entries(after.players)) if (!before.players[pid]?.down) expect(p.down ?? false).toBe(false);
    });
    expect(hashState(end)).toBe(hashState(h.room.state!));

    // the files replay to the same hash and help count, without asking the GM
    const forbidden = new Forbidden();
    const m2 = new RoomManager({ dir, engineVersion: ENGINE, scheduler: new ManualScheduler(h.sch.now()), log: () => {}, gm: aiConfig(forbidden) });
    m2.load();
    const back = m2.get(h.code)!;
    expect(hashState(back.state!)).toBe(hashState(h.room.state!));
    expect(helpOf(back)).toEqual(helpOf(h.room));
    expect(forbidden.calls).toBe(0);
    m2.closeAll('idle');
  }, 120_000);
});

describe('MP4 exit: demo rooms play without AI (the real server, no GM preset)', { timeout: 120_000 }, () => {
  it('a key in the environment alone builds no provider: health says offline, the demo room plays its recordings in lockstep', async () => {
    const dir = tempDir();
    const port = await freePort();
    // (the key is never used: with no preset the server must not build a GM provider at all)
    const env = { PORT: String(port), ANYWORLD_DATA_DIR: join(dir, 'data'), ANYWORLD_ENGINE_VERSION: ENGINE, ANYWORLD_TEST_TIMING: JSON.stringify({ travelMs: 20, countdownTurnMs: 50, deadlineMs: 300 }), ANYWORLD_GM_PRESET: '', ANYWORLD_TEST_GM: '', MISTRAL_API_KEY: 'test-key-never-sent' };
    const srv = await spawnServer(env, (p) => children.push(p));
    const base = `http://127.0.0.1:${srv.port}`;
    const health = await (await fetch(`${base}/api/health`)).json();
    expect(health.gm).toBe('offline');
    const r = await postJson(`${base}/api/rooms`, { engine: ENGINE, demo: 'fixture-western' }, { origin: base });
    expect(r.status).toBe(201);
    const info = await (await fetch(`${base}/api/rooms/${r.json.code}`)).json();
    expect(info.gm).toBe('recorded');
    const cs = [0, 1].map((i) => {
      const c = new ScriptedClient({ url: `ws://127.0.0.1:${port}/api/ws`, origin: base, room: r.json.code, name: `Bot ${i + 1}`, colour: PLAYER_COLOURS[i]!, engine: ENGINE, bot: BOTS[i]!, seed: 70 + i, retryMs: 600, ...(i === 0 ? { token: r.json.token } : {}) });
      scripted.push(c);
      return c;
    });
    for (const c of cs) await c.connect();
    cs[0]!.client.start();
    await until(() => cs.every((c) => !!c.state && !!c.pid), 10_000, 'the run');
    await Promise.all(cs.map((c) => c.play(60)));
    cs.forEach((c) => c.pause());
    await until(() => cs[0]!.n === cs[1]!.n, 15_000, 'one n');
    await new Promise((res) => setTimeout(res, 500));
    await until(() => cs[0]!.n === cs[1]!.n, 15_000, 'one n');
    expect(hashState(cs[0]!.state!)).toBe(hashState(cs[1]!.state!));
    for (const c of cs) expect(c.desyncs).toBe(0);
    // the recording's intro, for the party (aimed at the lead), as the run's first gm entry
    const intro = cs[0]!.entries.find((e) => e.k === 'gm');
    expect(intro).toMatchObject({ k: 'gm', hook: 'intro', pid: 'p1', actions: WESTERN_REC.recordings[0]!.json.actions });
    expect(srv.out.join('')).not.toMatch(/gm area \d+: \d+ calls|gm voice:|gm breaker/);
  });
});
