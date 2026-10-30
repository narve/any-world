/**
 * Bot playthroughs of World Spec files.
 *
 *   npm run sim -- --world content/worlds/fixture-ship.json --seeds 100 --bots explorer,cautious
 *   npm run sim -- --seeds 20                       # every content/worlds/*.json, explorer+cautious
 *   npm run sim -- --world a.json --json            # machine-readable output
 *
 * Options:
 *   --world <file>      world file (repeatable, or comma separated); default all content/worlds/*.json
 *   --seeds <n>         seeds per bot (1..n, or --seed-start s for s..s+n-1); default 20
 *   --bots <list>       explorer,cautious,talker,random; default explorer,cautious
 *   --max-turns <n>     engine turn cap per run (default 3000; random bot or an all-random party: min(cap, 800))
 *   --gm                feed scripted GM actions (spawn, offer_choice, add_rule/remove_rule)
 *   --jobs <n>          parallel worker processes (default: CPUs - 1)
 *   --exact             step through the public (cloning) step() instead of the in-place fastStep
 *                       (same results — tests/sim/fast.test.ts checks parity — but ~3× slower)
 *   --analyse           also print the static balance analysis and verdict per world
 *   --difficulty <d>    gentle|normal|hard|brutal: the band the games are played at (engine
 *                       difficulty) and the win-rate target for --analyse (default normal)
 *   --gate              the new-player gate (src/engine/balance/gate.ts): plays the newbie bot at
 *                       gentle and normal (ignores --bots / --difficulty) and checks its win rate
 *                       against the floors (gentle ≥ 50%, normal ≥ 25%); exit code 1 when a world fails
 *   --json              print JSON instead of tables
 *
 * Party runs (MP1; src/engine/sim/party.ts):
 *   --party <n>         play parties of n players (1..12) through the party turn API; player i plays
 *                       bot (i + seed) % |bots| of --bots, so seeds rotate who leads and who pairs up
 *   --party-sizes <l>   several party sizes, e.g. 2,3,4 (one summary row per size)
 *   --timing            time every party turn with performance.now (injected; the engine reads no
 *                       clock): mean / p95 / max ms for the whole turn, the engine's share and the
 *                       bots' share, and the engine split (turn, world, ai, fov)
 *   Summaries add downs, revives and refusals by reason. --gm and --gate are single player only.
 *   Exit code 1 also when a party run had an `illegal` refusal or another engine anomaly.
 *
 * Exit code 1 when any run crashed (or a world file is invalid, or --gate failed).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { cpus } from 'node:os';
import { parseWorld } from '../src/schema/refs';
import type { WorldSpec } from '../src/schema/world';
import { performance } from 'node:perf_hooks';
import {
  runGame,
  summarize,
  formatSummary,
  runParty,
  summarizeParty,
  formatPartySummary,
  partyBots,
  type SimResult,
  type PartyResult,
  type BotName,
  BOT_NAMES,
} from '../src/engine/sim/index';
import { MAX_PARTY_SIZE } from '../src/engine/index';
import { staticAnalysis, verdictFor, formatAnalysis, DIFFICULTIES, type Difficulty, NEW_PLAYER_GATE, GATE_BOT, gateFromResults, formatGate } from '../src/engine/balance/index';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);

interface Task {
  file: string;
  bot: BotName;
  seed: number;
  maxTurns: number;
  gm: boolean;
  exact: boolean;
  difficulty: Difficulty;
  /** party size (party mode only) */
  party?: number;
  timing?: boolean;
}

type AnyResult = SimResult | PartyResult;

const worldCache = new Map<string, WorldSpec>();
function loadWorld(file: string): WorldSpec {
  const hit = worldCache.get(file);
  if (hit) return hit;
  const r = parseWorld(JSON.parse(readFileSync(file, 'utf8')));
  if (!r.ok) throw new Error(`${file} is not a valid world:\n  ${r.errors.join('\n  ')}`);
  worldCache.set(file, r.world);
  return r.world;
}

function runTask(t: Task): AnyResult {
  if (t.party) {
    return runParty(loadWorld(t.file), t.seed, partyBots(t.bot.split('+') as BotName[], t.party), {
      maxTurns: t.maxTurns,
      fast: !t.exact,
      difficulty: t.difficulty,
      ...(t.timing ? { now: () => performance.now() } : {}),
    });
  }
  return runGame(loadWorld(t.file), t.seed, t.bot, { maxTurns: t.maxTurns, gm: t.gm, fast: !t.exact, difficulty: t.difficulty });
}

// ---------------------------------------------------------------------------
// worker process
// ---------------------------------------------------------------------------

if (process.env.ANYWORLD_SIM_WORKER === '1') {
  process.on('message', (msg: { tasks: Task[] }) => {
    const out: AnyResult[] = [];
    for (const t of msg.tasks) out.push(runTask(t));
    process.send!({ results: out }, () => process.exit(0));
  });
} else {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const o = {
    worlds: [] as string[],
    seeds: 20,
    seedStart: 1,
    bots: ['explorer', 'cautious'] as BotName[],
    maxTurns: 3000,
    gm: false,
    exact: false,
    jobs: Math.max(1, cpus().length - 1),
    json: false,
    analyse: false,
    gate: false,
    difficulty: 'normal' as Difficulty,
    partySizes: [] as number[],
    timing: false,
  };
  const size = (v: string) => {
    const n = Number(v) | 0;
    if (n < 1 || n > MAX_PARTY_SIZE) throw new Error(`party size must be 1..${MAX_PARTY_SIZE}, got "${v}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--world':
      case '--worlds':
        o.worlds.push(...val().split(',').filter(Boolean));
        break;
      case '--seeds':
        o.seeds = Math.max(1, Number(val()) | 0);
        break;
      case '--seed-start':
        o.seedStart = Number(val()) | 0;
        break;
      case '--bots':
        o.bots = val().split(',').filter(Boolean) as BotName[];
        for (const b of o.bots) if (!(BOT_NAMES as readonly string[]).includes(b)) throw new Error(`unknown bot "${b}" (known: ${BOT_NAMES.join(', ')})`);
        break;
      case '--max-turns':
        o.maxTurns = Math.max(10, Number(val()) | 0);
        break;
      case '--gm':
        o.gm = true;
        break;
      case '--exact':
        o.exact = true;
        break;
      case '--jobs':
        o.jobs = Math.max(1, Number(val()) | 0);
        break;
      case '--json':
        o.json = true;
        break;
      case '--analyse':
      case '--analyze':
        o.analyse = true;
        break;
      case '--gate':
        o.gate = true;
        break;
      case '--difficulty': {
        const d = val();
        if (!(DIFFICULTIES as readonly string[]).includes(d)) throw new Error(`unknown difficulty "${d}" (known: ${DIFFICULTIES.join(', ')})`);
        o.difficulty = d as Difficulty;
        break;
      }
      case '--party':
        o.partySizes = [size(val())];
        break;
      case '--party-sizes':
        o.partySizes = [...new Set(val().split(',').filter(Boolean).map(size))].sort((a, b) => a - b);
        break;
      case '--timing':
        o.timing = true;
        break;
      case '--help':
      case '-h':
        console.log(readFileSync(self, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${a}`);
    }
  }
  if (!o.worlds.length) {
    const dir = join(root, 'content', 'worlds');
    if (existsSync(dir)) o.worlds = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f));
  }
  o.worlds = o.worlds.map((w) => resolve(w));
  if (o.partySizes.length && (o.gm || o.gate)) throw new Error('--gm and --gate are single player only (not with --party / --party-sizes)');
  if (o.timing && !o.partySizes.length) throw new Error('--timing needs --party or --party-sizes');
  return o;
}

async function runParallel(tasks: Task[], jobs: number): Promise<AnyResult[]> {
  if (jobs <= 1 || tasks.length < 4) return tasks.map(runTask);
  // interleave so every worker gets a mix of worlds/bots
  const buckets: Task[][] = Array.from({ length: Math.min(jobs, tasks.length) }, () => []);
  tasks.forEach((t, i) => buckets[i % buckets.length].push(t));
  const parts = await Promise.all(
    buckets.map(
      (bucket) =>
        new Promise<AnyResult[]>((res, rej) => {
          const child = fork(self, [], { execArgv: process.execArgv, env: { ...process.env, ANYWORLD_SIM_WORKER: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
          let got: AnyResult[] | null = null;
          child.on('message', (m: { results: AnyResult[] }) => {
            got = m.results;
          });
          child.on('error', rej);
          child.on('exit', (code) => (got ? res(got) : rej(new Error(`sim worker exited with code ${code} before reporting`))));
          child.send({ tasks: bucket });
        }),
    ),
  );
  // back to task order: task i ran in bucket i % B at position floor(i / B)
  return tasks.map((_, i) => parts[i % parts.length][Math.floor(i / parts.length)]);
}

type Opts = ReturnType<typeof parseArgs>;

/** --party / --party-sizes: every world × party size × seed, one bot mix per run */
async function partyMain(o: Opts, worlds: Map<string, WorldSpec>, bad: number): Promise<void> {
  const tasks: Task[] = [];
  for (const [file] of worlds)
    for (const n of o.partySizes)
      for (let k = 0; k < o.seeds; k++) {
        const seed = o.seedStart + k;
        // the mix is fixed per task (seed rotates the order); the worker rebuilds it from `bot`
        const bots = partyBots(o.bots, n, seed);
        // the random bot's cap only when nobody else carries the party
        const maxTurns = bots.every((b) => b === 'random') ? Math.min(o.maxTurns, 800) : o.maxTurns;
        tasks.push({ file, bot: bots.join('+') as BotName, seed, maxTurns, gm: false, exact: o.exact, difficulty: o.difficulty, party: n, timing: o.timing });
      }
  const t0 = Date.now();
  const results = (await runParallel(tasks, o.jobs)) as PartyResult[];
  const secs = (Date.now() - t0) / 1000;
  const report: unknown[] = [];
  const text: string[] = [];
  const all: PartyResult[] = [];
  let crashes = 0;
  let anomalies = 0;
  for (const [file, world] of worlds) {
    const rs = results.filter((_, i) => tasks[i].file === file);
    all.push(...rs);
    const sums = summarizeParty(rs, world.areas.length);
    crashes += sums.reduce((n, s) => n + s.crash, 0);
    anomalies += sums.reduce((n, s) => n + s.anomalies.length, 0);
    const rel = file.startsWith(root) ? file.slice(root.length + 1) : file;
    const played = [...new Set(rs.map((r) => r.difficulty))];
    report.push({ file: rel, title: world.meta.title, difficulty: played.length === 1 ? played[0] : played, summaries: sums });
    text.push(formatPartySummary(`${rel} — "${world.meta.title}" (${played.join(', ')})`, sums));
  }
  const total = summarizeParty(all, Math.max(1, ...[...worlds.values()].map((w) => w.areas.length)));
  if (o.json) console.log(JSON.stringify({ seconds: secs, runs: results.length, worlds: report, total }, null, 2));
  else {
    console.log(text.join('\n\n'));
    if (worlds.size > 1) console.log('\n' + formatPartySummary(`all ${worlds.size} worlds`, total));
    console.log(`\n${results.length} party runs in ${secs.toFixed(1)}s (${o.jobs} jobs)${crashes ? `, ${crashes} CRASHED` : ''}${anomalies ? `, ${anomalies} ANOMALIES` : ''}`);
  }
  process.exit(crashes || bad || anomalies ? 1 : 0);
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  if (!o.worlds.length) throw new Error('no world files (pass --world <file>)');
  const worlds = new Map<string, WorldSpec>();
  let bad = 0;
  for (const f of o.worlds) {
    try {
      worlds.set(f, loadWorld(f));
    } catch (e) {
      bad++;
      console.error((e as Error).message);
    }
  }
  if (o.partySizes.length) return partyMain(o, worlds, bad);
  const tasks: Task[] = [];
  const levels: Difficulty[] = o.gate ? (Object.keys(NEW_PLAYER_GATE) as Difficulty[]) : [o.difficulty];
  const bots: BotName[] = o.gate ? [GATE_BOT] : o.bots;
  for (const [file] of worlds)
    for (const difficulty of levels)
      for (const bot of bots)
        for (let k = 0; k < o.seeds; k++)
          tasks.push({ file, bot, seed: o.seedStart + k, maxTurns: bot === 'random' ? Math.min(o.maxTurns, 800) : o.maxTurns, gm: o.gm, exact: o.exact, difficulty });
  const t0 = Date.now();
  const results = (await runParallel(tasks, o.jobs)) as SimResult[];
  const secs = (Date.now() - t0) / 1000;
  let crashes = 0;
  let gateFails = 0;
  const report: unknown[] = [];
  const text: string[] = [];
  for (const [file, world] of worlds) {
    const rs = results.filter((_, i) => tasks[i].file === file);
    const sums = summarize(rs, world.areas.length);
    crashes += sums.reduce((n, s) => n + s.crash, 0);
    const rel = file.startsWith(root) ? file.slice(root.length + 1) : file;
    // the band the games were really played at (from GameState.difficulty), not just the requested one
    const played = [...new Set(rs.map((r) => r.difficulty))];
    const entry: Record<string, unknown> = { file: rel, title: world.meta.title, difficulty: played.length === 1 ? played[0] : played, summaries: sums };
    if (o.gate) text.push(`${rel} — "${world.meta.title}"`);
    else text.push(formatSummary(`${rel} — "${world.meta.title}" (${played.join(', ')})`, sums));
    if (o.gate) {
      const g = gateFromResults(world, rs);
      if (!g.pass) gateFails++;
      entry.gate = g;
      text.push(formatGate(g));
    }
    if (o.analyse && !o.gate) {
      const sa = staticAnalysis(world);
      const v = verdictFor(world, sa, sums, o.difficulty);
      entry.static = sa;
      entry.verdict = v;
      text.push(formatAnalysis(sa, v));
    }
    const anomalies = rs.flatMap((r) => r.anomalies);
    if (anomalies.length) {
      entry.anomalies = anomalies.slice(0, 20);
      text.push(`  anomalies:\n    ${anomalies.slice(0, 10).join('\n    ')}`);
    }
    report.push(entry);
  }
  if (o.json) console.log(JSON.stringify({ seconds: secs, runs: results.length, worlds: report }, null, 2));
  else {
    console.log(text.join('\n\n'));
    console.log(`\n${results.length} runs in ${secs.toFixed(1)}s (${o.jobs} jobs)${crashes ? `, ${crashes} CRASHED` : ''}${o.gate ? `, new-player gate: ${gateFails ? `${gateFails} of ${worlds.size} worlds FAIL` : 'all pass'}` : ''}`);
  }
  process.exit(crashes || bad || gateFails ? 1 : 0);
}
