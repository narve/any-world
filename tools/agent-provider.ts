/**
 * Agents as the LLM provider (DESIGN §9): check a response an agent wrote for a prompt from
 * tools/print-prompt.ts, through the SAME steps the game runs (extract JSON → zod → reference /
 * engine checks), print the problems exactly as the repair message the LLM would get back, and
 * record good responses as fixtures.
 *
 * World:
 *   npx tsx tools/agent-provider.ts --purpose world --response reply.json \
 *       [--prompt "…" --language nb --difficulty normal --weirdness 0.5]   (same as print-prompt)
 *       [--seeds 40] [--no-balance] [--tune] [--record] [--id my-world] [--force] [--loose]
 *   - invalid: prints "Your previous reply could not be used. Problems found: …" (the repair turn)
 *     and exits 1;
 *   - valid: meta.language / meta.prompt are set from the arguments (as the game does), unknown keys
 *     are listed (the game ignores them; --record refuses them unless --loose), then a balance check
 *     runs (static analysis + explorer and cautious bots on --seeds seeds, default 40, at
 *     --difficulty) and prints the report. Exit 2 when the verdict is unwinnable / broken, and the
 *     balance feedback message the game would send back is printed.
 *   - --tune also runs the automatic rebalance (tuneWorld) and records the tuned world.
 *   - --record writes content/worlds/<id>.json (id: --id or a slug of the title; --force overwrites).
 *
 * GM moment / dialogue turn (same arguments as print-prompt, which rebuild the same snapshot):
 *   npx tsx tools/agent-provider.ts --purpose gm --world fixture-ship --hook area_enter --area 1 \
 *       --response gm.json [--record]
 *   npx tsx tools/agent-provider.ts --purpose dialogue --world fixture-teen --npc janitor \
 *       --response turn.json [--say "…"] [--history h.json] [--record]
 *   - validates (GmResponse / DialogueResponse + engine dry run of every action) and prints the
 *     repair message on failure (exit 1); on success lists the actions with their budget cost and
 *     which count as helpful;
 *   - --record appends the response to content/recordings/<worldKey>/<file>.json under the scoped
 *     purpose (gm:<hook>/<worldKey>/a<area>, dialogue/<worldKey>/<npc def id>) that demo mode looks up.
 *
 * --worlds-dir / --recordings-dir record somewhere else than content/worlds / content/recordings.
 * --response - reads the reply from stdin. The reply may be bare JSON, fenced, or have prose around
 * it (the game extracts it the same way). --dump-request prints the prompt that was checked.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRequestFromArgs, formatRequest, num, parseArgs, root, str, difficultyArg, type Args } from './print-prompt';
import { WorldSpec } from '../src/schema/world';
import { DialogueResponse, GmResponse, GM_ACTION_COST } from '../src/schema/gm';
import { findUnknownKeys } from '../src/schema/refs';
import { checkStructuredText, extractJson, repairMessage } from '../src/llm/structured';
import { balanceFeedbackMessage, checkWorldReply, finaliseWorld, isUnplayable } from '../src/llm/generate';
import { dialogueResponseErrors, gmResponseErrors, isHelpfulAction } from '../src/llm/gm-checks';
import { recordingFileName, worldKeyOf } from '../src/llm/recording-keys';
import { HELPFUL_CEILING } from '../src/llm/prompts/gm';
import { parseRecordingsFile, type Recording } from '../src/llm/mock';
import { analyseWorld, formatAnalysis, tuneWorld } from '../src/engine/balance/index';
import { stateForHook } from '../src/llm/situation';

function readResponse(args: Args): string {
  const r = str(args, 'response');
  if (!r) throw new Error('--response <file|-> is required');
  return r === '-' ? readFileSync(0, 'utf8') : readFileSync(r, 'utf8');
}

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function appendRecording(args: Args, worldKey: string, rec: Recording): string {
  const dir = join(str(args, 'recordings-dir') ?? join(root, 'content', 'recordings'), worldKey);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, recordingFileName(rec.purpose));
  const existing = existsSync(file) ? parseRecordingsFile(JSON.parse(readFileSync(file, 'utf8'))) : [];
  existing.push(rec);
  writeFileSync(file, JSON.stringify({ recordings: existing }, null, 2) + '\n');
  return file;
}

async function world(args: Args): Promise<number> {
  const text = readResponse(args);
  const checked = await checkWorldReply(text);
  if (!checked.ok) {
    out(`INVALID: ${checked.errors.length} problem${checked.errors.length === 1 ? '' : 's'}. The model would get this repair message:\n`);
    out(checked.repair);
    return 1;
  }
  const opts = { prompt: str(args, 'prompt') ?? '', language: str(args, 'language') ?? 'en' };
  let w = finaliseWorld(checked.value, opts);
  const raw = extractJson(text);
  const rawJson = raw.ok ? (raw.value as Record<string, unknown>) : {};
  const unknown = findUnknownKeys(rawJson, WorldSpec.parse(rawJson));
  out(`VALID: "${w.meta.title}" (${w.meta.genre}, ${w.meta.language}) — ${w.areas.length} areas, ${w.actors.length} actors, ${w.items.length} items, ${w.rules.length} rules`);
  if (unknown.length) {
    out(`\nunknown keys (ignored by the game${args.loose ? '' : '; --record refuses them unless --loose'}):`);
    for (const u of unknown) out(`  - ${u}`);
  }
  const difficulty = difficultyArg(args);
  let verdictBad = false;
  let tuned = false;
  if (!args['no-balance']) {
    const seeds = num(args, 'seeds', 40);
    out(`\nbalance: ${seeds} seeds × explorer, cautious at ${difficulty}…`);
    const t0 = Date.now();
    if (args.tune) {
      const res = tuneWorld(w, { seeds, bots: ['explorer', 'cautious'], difficulty, fast: true });
      for (const h of res.history) out(`  round ${h.round}: ${h.verdict} (${Math.round(h.winRate * 100)}% over ${h.runs ?? '?'} runs)${h.changes.length ? ` — ${h.changes.join('; ')}` : ''}`);
      tuned = res.world !== w;
      w = res.world;
      out(formatAnalysis(res.report.static, res.report));
      verdictBad = isUnplayable(res.report.verdict);
      if (verdictBad) out(`\nThe model would get this balance feedback:\n\n${balanceFeedbackMessage(res.report)}`);
    } else {
      const rep = analyseWorld(w, { seeds, bots: ['explorer', 'cautious'], difficulty, fast: true });
      for (const s of rep.sims) {
        out(`  ${s.bot.padEnd(9)} won ${Math.round(s.winRate * 100)}% (${s.won}/${s.runs}), stuck ${s.stuck}, crash ${s.crash}, avg turns ${Math.round(s.avgTurns ?? 0)}`);
      }
      out(formatAnalysis(rep.static, rep));
      verdictBad = isUnplayable(rep.verdict);
      if (verdictBad) out(`\nThe model would get this balance feedback:\n\n${balanceFeedbackMessage(rep)}`);
      else if (rep.verdict !== 'ok')
        out(`\nThe game does not send a ${rep.verdict} world back to the model: it rebalances it automatically. Re-run with --tune to see (and --record) the tuned world, or fix the numbers yourself.`);
    }
    out(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  if (args.record) {
    if (unknown.length && !args.loose) {
      out('\nnot recorded: fix the unknown keys first (or pass --loose)');
      return 1;
    }
    if (verdictBad && !args.force) {
      out('\nnot recorded: the balance verdict is unplayable (pass --force to record anyway)');
      return 2;
    }
    const id = str(args, 'id') ?? worldKeyOf(w);
    const file = join(str(args, 'worlds-dir') ?? join(root, 'content', 'worlds'), `${id}.json`);
    if (existsSync(file) && !args.force) {
      out(`\nnot recorded: ${file} exists (pass --force to overwrite or --id to pick another id)`);
      return 1;
    }
    // record the agent's JSON as written (meta fixed up), or the tuned world when tuning changed it
    const body = tuned ? w : { ...rawJson, meta: { ...(rawJson.meta as object), language: w.meta.language, prompt: w.meta.prompt } };
    writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
    out(`\nrecorded ${file}`);
  }
  return verdictBad ? 2 : 0;
}

async function gmOrDialogue(args: Args): Promise<number> {
  const built = buildRequestFromArgs(args);
  if (args['dump-request']) out(formatRequest(built.request) + '\n');
  const w = built.world!;
  // the same hook-shaped snapshot the prompt showed (low_hp at a quarter hp, death / victory ended)
  const state = built.hook ? stateForHook(built.situation!, built.hook) : built.situation!.state;
  const text = readResponse(args);
  const isGm = built.purpose === 'gm';
  const checked = isGm
    ? await checkStructuredText(text, GmResponse, (r) => gmResponseErrors(w, state, r, built.hook))
    : await checkStructuredText(text, DialogueResponse, (r) => dialogueResponseErrors(w, state, built.npcId!, r));
  if (!checked.ok) {
    out(`INVALID: ${checked.errors.length} problem${checked.errors.length === 1 ? '' : 's'}. The model would get this repair message:\n`);
    out(repairMessage(checked.errors, false));
    return 1;
  }
  const value = checked.value as GmResponse | DialogueResponse;
  out(`VALID ${built.purpose} response for ${built.request.purpose} (area ${state.area.index}, turn ${state.turn}, budget ${state.area.gmBudget} left)`);
  if (!isGm) {
    const d = value as DialogueResponse;
    out(`  reply: ${d.reply}`);
    for (const o of d.options) out(`  option: ${o}`);
    if (d.actions.some((a) => a.type === 'trade')) out('  WARNING: trade actions are dropped in conversations (the game lists a trader\'s goods itself); remove them');
    if (d.end) out('  (ends the conversation)');
  }
  let cost = 0;
  let helpful = 0;
  for (const a of value.actions) {
    const c = GM_ACTION_COST[a.type] ?? 0;
    cost += c;
    const h = isHelpfulAction(w, a);
    if (h) helpful++;
    const gist = 'text' in a ? `: ${a.text}` : 'item' in a ? `: ${a.item}` : 'actor' in a ? `: ${a.actor}` : a.type === 'add_rule' ? `: ${a.rule.name} — ${a.rule.description}` : '';
    out(`  - ${a.type} (cost ${c}${h ? ', helpful' : ''})${gist}`);
  }
  out(`  total cost ${cost}, helpful actions ${helpful}`);
  {
    const ceiling = HELPFUL_CEILING[difficultyArg(args)];
    if (helpful > ceiling)
      out(
        `  WARNING: ${helpful} helpful actions, but the help ceiling at ${difficultyArg(args)} is ${ceiling} per area; the game keeps the first ${ceiling} and silently drops the rest. Trim the reply before --record.`,
      );
  }
  if (args.record) {
    const raw = extractJson(text);
    const file = appendRecording(args, built.worldKey!, { purpose: built.request.purpose, json: raw.ok ? raw.value : value });
    out(`\nrecorded under "${built.request.purpose}" in ${file}`);
  }
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    const src = readFileSync(new URL(import.meta.url), 'utf8');
    out(/\/\*\*([\s\S]*?)\*\//.exec(src)?.[1]?.replace(/^ \* ?/gm, '') ?? '');
    return 0;
  }
  const purpose = str(args, 'purpose') ?? 'world';
  return purpose === 'world' ? world(args) : gmOrDialogue(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
