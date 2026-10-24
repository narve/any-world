/**
 * Print the exact prompt the game would send to the LLM (agents-as-provider, DESIGN §9).
 *
 * World generation:
 *   npx tsx tools/print-prompt.ts --purpose world --prompt "a drowned cathedral full of clockwork saints" \
 *       --language nb --difficulty normal --weirdness 0.5 [--recent "Title A;Title B"] [--seed 7] [--out p.txt]
 *   (no --prompt = "surprise me"; --seed picks the genre × era × tone × twist draw)
 *
 * A GM moment (the snapshot is played deterministically by the explorer bot):
 *   npx tsx tools/print-prompt.ts --purpose gm --world fixture-ship --hook area_enter --area 1 \
 *       [--turn 0] [--seed 1] [--difficulty normal] [--weirdness 0.5] [--world-key fixture-ship]
 *
 * One NPC dialogue turn:
 *   npx tsx tools/print-prompt.ts --purpose dialogue --world fixture-teen --npc janitor --area 0 \
 *       [--turn 30] [--say "What happened to the gym?"] [--history history.json]
 *
 * Output: the system prompt and the user message between ===== markers, then the request metadata
 * (purpose, schema name, max tokens, request hash). --json prints the CompletionRequest as JSON
 * instead; --out <file> writes to a file. --world takes a file path or a content/worlds id.
 * Feed the reply to tools/agent-provider.ts with the SAME arguments plus --response <file>.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseWorld } from '../src/schema/refs';
import type { WorldSpec } from '../src/schema/world';
import { Difficulty, GmHook } from '../src/schema/gm';
import type { CompletionRequest } from '../src/llm/types';
import { requestHash } from '../src/llm/hash';
import { worldRequest } from '../src/llm/prompts/world';
import { gmRequest } from '../src/llm/prompts/gm';
import { dialogueRequest, type DialogueLine } from '../src/llm/prompts/dialogue';
import { WORLD_JSON_HINT_SCHEMA } from '../src/llm/generate';
import { gmJsonSchema, dialogueJsonSchema } from '../src/llm/gm-checks';
import { dialoguePurpose, gmPurpose, safeKey } from '../src/llm/recording-keys';
import { dialogueInputFor, gmInputFor, playToSituation, type Situation } from '../src/llm/situation';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type Args = Record<string, string | true>;

/** --key value / --flag parsing (repeated keys: last wins) */
export function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`);
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

export function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

export function num(args: Args, key: string, fallback: number): number {
  const v = str(args, key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number (got "${v}")`);
  return n;
}

export function difficultyArg(args: Args): Difficulty {
  const d = str(args, 'difficulty') ?? 'normal';
  const p = Difficulty.safeParse(d);
  if (!p.success) throw new Error(`--difficulty must be one of ${Difficulty.options.join(', ')}`);
  return p.data;
}

/** a world file path or a content/worlds id → {world, key} */
export function loadWorldArg(args: Args): { world: WorldSpec; key: string; file: string } {
  const w = str(args, 'world');
  if (!w) throw new Error('--world <file|id> is required for this purpose');
  const file = existsSync(w) ? resolve(w) : join(root, 'content', 'worlds', w.endsWith('.json') ? w : `${w}.json`);
  if (!existsSync(file)) throw new Error(`world "${w}" not found (tried ${file})`);
  const r = parseWorld(JSON.parse(readFileSync(file, 'utf8')));
  if (!r.ok) throw new Error(`${file} is not a valid world:\n  ${r.errors.slice(0, 10).join('\n  ')}`);
  return { world: r.world, key: safeKey(str(args, 'world-key') ?? basename(file, '.json')), file };
}

export function situationArg(world: WorldSpec, args: Args): Situation {
  const sit = playToSituation(world, {
    seed: num(args, 'seed', 1),
    area: num(args, 'area', 0),
    turnsInArea: num(args, 'turn', 0),
    difficulty: difficultyArg(args),
  });
  if (!sit.reached) {
    process.stderr.write(
      `note: the bot did not reach area ${num(args, 'area', 0)} turn +${num(args, 'turn', 0)} (run ${sit.state.status} in area ${sit.state.area.index} at turn ${sit.state.turn}); using that snapshot\n`,
    );
  }
  return sit;
}

export interface BuiltRequest {
  purpose: 'world' | 'gm' | 'dialogue';
  request: CompletionRequest;
  /** gm / dialogue context (for validation in agent-provider) */
  world?: WorldSpec;
  worldKey?: string;
  situation?: Situation;
  hook?: GmHook;
  npcId?: string;
}

/** build the request exactly as the game would, from CLI arguments */
export function buildRequestFromArgs(args: Args): BuiltRequest {
  const purpose = str(args, 'purpose') ?? 'world';
  if (purpose === 'world') {
    const request = worldRequest(
      {
        prompt: str(args, 'prompt') ?? '',
        language: str(args, 'language') ?? 'en',
        difficulty: difficultyArg(args),
        weirdness: num(args, 'weirdness', 0.5),
        surpriseSeed: num(args, 'seed', 1),
        recentWorlds: (str(args, 'recent') ?? '').split(';').filter(Boolean),
      },
      { jsonSchema: WORLD_JSON_HINT_SCHEMA, schemaInPrompt: false },
    );
    return { purpose: 'world', request };
  }
  if (purpose === 'gm') {
    const { world, key } = loadWorldArg(args);
    const hookArg = str(args, 'hook') ?? 'area_enter';
    const hp = GmHook.safeParse(hookArg);
    if (!hp.success) throw new Error(`--hook must be one of ${GmHook.options.join(', ')}`);
    const sit = situationArg(world, args);
    const detail: Record<string, string | number> = {};
    for (const k of ['actorId', 'reason', 'regionName', 'questId'] as const) {
      const v = str(args, k);
      if (v !== undefined) detail[k] = v;
    }
    if (str(args, 'level')) detail.level = num(args, 'level', 2);
    const input = gmInputFor(world, sit, hp.data, { weirdness: num(args, 'weirdness', 0.5), detail: Object.keys(detail).length ? detail : undefined, helpfulUsed: num(args, 'help-used', 0) });
    const request = gmRequest(input, gmPurpose(hp.data, key, sit.state.area.index), { jsonSchema: gmJsonSchema(), schemaInPrompt: false });
    return { purpose: 'gm', request, world, worldKey: key, situation: sit, hook: hp.data };
  }
  if (purpose === 'dialogue') {
    const { world, key } = loadWorldArg(args);
    const npc = str(args, 'npc');
    if (!npc) throw new Error('--npc <actor def id or instance id> is required for dialogue');
    const sit = situationArg(world, args);
    const histFile = str(args, 'history');
    const history: DialogueLine[] = histFile ? (JSON.parse(readFileSync(histFile, 'utf8')) as DialogueLine[]) : [];
    const input = dialogueInputFor(world, sit, npc, { history, playerLine: str(args, 'say') ?? '' });
    const defId = sit.state.area.actors.find((a) => a.id === input.npcId)!.defId;
    const request = dialogueRequest({ ...input, helpfulUsed: num(args, 'help-used', 0) }, dialoguePurpose(key, defId), { jsonSchema: dialogueJsonSchema(), schemaInPrompt: false });
    return { purpose: 'dialogue', request, world, worldKey: key, situation: sit, npcId: input.npcId };
  }
  throw new Error(`--purpose must be world, gm or dialogue (got "${purpose}")`);
}

export function formatRequest(req: CompletionRequest): string {
  const lines = ['===== SYSTEM =====', req.system];
  for (const m of req.messages) lines.push(`===== ${m.role.toUpperCase()} =====`, m.content);
  lines.push(
    '===== META =====',
    `purpose: ${req.purpose}`,
    `schemaName: ${req.schemaName ?? '-'}`,
    `maxTokens: ${req.maxTokens ?? '-'}`,
    `temperature: ${req.temperature ?? '-'}`,
    `requestHash: ${requestHash(req)}`,
    `system chars: ${req.system.length}, user chars: ${req.messages.map((m) => m.content.length).join('+')}`,
  );
  return lines.join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    process.stdout.write(`${/\/\*\*([\s\S]*?)\*\//.exec(src)?.[1]?.replace(/^ \* ?/gm, '') ?? ''}\n`);
    return;
  }
  const built = buildRequestFromArgs(args);
  const { signal: _s, ...plain } = built.request;
  void _s;
  const text = args.json ? JSON.stringify(plain, null, 2) : formatRequest(built.request);
  const out = str(args, 'out');
  if (out) {
    writeFileSync(out, text + '\n');
    process.stderr.write(`wrote ${out} (${text.length} chars)\n`);
  } else process.stdout.write(text + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
