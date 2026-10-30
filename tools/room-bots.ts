/**
 * Scripted bots in a room of a running server (MP2 design §11), by hand or from the exit checks.
 *
 *   npx tsx tools/room-bots.ts --url http://127.0.0.1:8787 --bots 4 --entries 200
 *   npx tsx tools/room-bots.ts --url https://any-game.dv8.no --origin https://any.dv8.no --room K7QX --bots 2
 *
 * Options:
 *   --url <http(s)://host:port>  the server (required); the socket is <url>/api/ws
 *   --room <code>        join this room as guests (its host starts the run); default: create a room
 *                        with --demo, the first bot is its host and starts the run
 *   --demo <id>          demo world for a new room (default fixture-western)
 *   --bots <n>           how many clients (1–12, default 4)
 *   --bot <list>         sim bots, rotated over the clients (default explorer,cautious,talker,newbie)
 *   --entries <n>        play until the room has applied this many entries (default 150) or the run ends
 *   --chat-every <k>     each client says a line about every k entries (default 25; 0 = no chat)
 *   --origin <origin>    the Origin header (default: the --url origin)
 *   --engine <v>         the engine version sent in hello (default: computeEngineVersion of this checkout)
 *   --timeout <s>        give up after this many seconds (default 300)
 *
 * Prints one line per client at the end and `[room-bots] ok room <code> n=<n> hash=<h>` when every
 * client ended on the same hash; exit code 1 otherwise (or on a refusal, a fault or the timeout).
 */
import { hashState } from '../src/engine/index';
import { BOT_NAMES, type BotName } from '../src/engine/sim/bots';
import { PLAYER_COLOURS } from '../src/net/protocol';
import { computeEngineVersion } from '../server/engine-version';
import { ScriptedClient } from './rooms/scripted-client';

interface Args {
  url: string;
  room?: string;
  demo: string;
  bots: number;
  bot: BotName[];
  entries: number;
  chatEvery: number;
  origin?: string;
  engine?: string;
  timeout: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { url: '', demo: 'fixture-western', bots: 4, bot: ['explorer', 'cautious', 'talker', 'newbie'], entries: 150, chatEvery: 25, timeout: 300 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    const int = (lo: number, hi: number) => {
      const x = Number(v());
      if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(`${k} must be an integer ${lo}–${hi}`);
      return x;
    };
    if (k === '--url') a.url = v().replace(/\/+$/, '');
    else if (k === '--room') a.room = v().toUpperCase();
    else if (k === '--demo') a.demo = v();
    else if (k === '--bots') a.bots = int(1, 12);
    else if (k === '--bot') {
      a.bot = v().split(',').map((s) => s.trim()) as BotName[];
      for (const b of a.bot) if (!BOT_NAMES.includes(b)) throw new Error(`unknown bot "${b}" (known: ${BOT_NAMES.join(', ')})`);
    } else if (k === '--entries') a.entries = int(1, 1_000_000);
    else if (k === '--chat-every') a.chatEvery = int(0, 1_000_000);
    else if (k === '--origin') a.origin = v();
    else if (k === '--engine') a.engine = v();
    else if (k === '--timeout') a.timeout = int(1, 86_400);
    else throw new Error(`unknown option ${k}`);
  }
  if (!/^https?:\/\//.test(a.url)) throw new Error('--url http(s)://host:port is required');
  return a;
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const engine = a.engine ?? computeEngineVersion();
  const origin = a.origin ?? new URL(a.url).origin;
  const wsUrl = `${a.url.replace(/^http/, 'ws')}/api/ws`;
  let room = a.room;
  let token: string | undefined;
  if (!room) {
    const res = await fetch(`${a.url}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ engine, demo: a.demo }) });
    const body = (await res.json().catch(() => null)) as { code?: string; token?: string; error?: { kind?: string } } | null;
    if (res.status !== 201 || !body?.code) {
      console.error(`[room-bots] cannot create a room: ${res.status} ${JSON.stringify(body)}`);
      return 1;
    }
    room = body.code;
    token = body.token;
    console.log(`[room-bots] created room ${room} (${a.demo})`);
  }
  const clients: ScriptedClient[] = [];
  for (let i = 0; i < a.bots; i++) {
    clients.push(
      new ScriptedClient({
        url: wsUrl,
        origin,
        room,
        name: `Bot ${i + 1}`,
        colour: PLAYER_COLOURS[i % PLAYER_COLOURS.length],
        engine,
        bot: a.bot[i % a.bot.length],
        seed: 1000 + i,
        chatEvery: a.chatEvery,
        ...(i === 0 && token ? { token } : {}),
      }),
    );
  }
  const timer = setTimeout(() => {
    console.error(`[room-bots] timed out after ${a.timeout} s`);
    for (const c of clients) console.error(`  ${c.opts.name}: n=${c.n} status=${c.client.status}`);
    process.exit(1);
  }, a.timeout * 1000);
  try {
    // the creator first, so it keeps the host seat
    for (const c of clients) {
      const w = await c.connect();
      console.log(`[room-bots] ${c.opts.name} joined as ${w.you.seat}${w.you.host ? ' (host)' : ''}`);
    }
    const host = clients.find((c) => c.client.host);
    if (host && host.client.phase !== 'playing') host.client.start();
    await Promise.all(clients.map((c) => c.playUntil(() => c.n >= a.entries)));
    for (const c of clients) c.pause();
    // the bots stopped: entries still in flight reach everyone
    const end = Date.now() + 10_000;
    while (!clients.every((c) => c.client.status === 'joined' && c.n === clients[0].n) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const hashes = clients.map((c) => (c.state ? hashState(c.state) : '-'));
    for (const [i, c] of clients.entries()) {
      console.log(
        `  ${c.opts.name} (${c.bot.name}) ${c.pid ?? '-'}: n=${c.n} area=${c.state?.area.index ?? '-'} hash=${hashes[i]} sent=${c.sent} chat=${c.said} desyncs=${c.desyncs} reconnects=${c.reconnects} refusals=${c.refusals.length} notices=${c.notices.map((x) => x.key).join(',') || '-'}`,
      );
    }
    const agreed = clients.every((c, i) => c.n === clients[0].n && hashes[i] === hashes[0] && hashes[i] !== '-');
    const status = clients[0].state?.status ?? '-';
    if (!agreed) {
      console.error(`[room-bots] the clients disagree`);
      return 1;
    }
    console.log(`[room-bots] ok room ${room} n=${clients[0].n} status=${status} hash=${hashes[0]}`);
    return 0;
  } catch (e) {
    console.error(`[room-bots] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    clearTimeout(timer);
    for (const c of clients) await c.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[room-bots] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
