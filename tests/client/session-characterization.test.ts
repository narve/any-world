/**
 * MP3 D2: a single-player characterization recording of GameSession, written before the room-session
 * refactor (docs/progress/MP3-DESIGN.md §1.2, §7). A sim bot plays six single-player runs through
 * the calls the browser controller makes (uiAction, intents, dialogueReply / dialogueLeave / trade,
 * click-to-travel with travelTick, the offline GM through applyGm, NPC voice answers), and every
 * step records the toasts, the narration card, the dialogue history, voice requests, the onboarding
 * card and the new log lines. The recording in session-characterization.jsonl must stay
 * byte-identical: the refactor keeps single player exactly as it was.
 *
 * Regenerate (only when a change is meant to alter single player, and say why in the commit):
 *   UPDATE_CHARACTERIZATION=1 npx vitest run tests/client/session-characterization.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFixture } from '../engine/helpers';
import { GameSession, type Outcome } from '../../src/client/session';
import { OfflineGmDirector, sanitizeResponse } from '../../src/client/gm-director';
import { dialogueMap } from '../../src/client/view';
import { visibleHostiles } from '../../src/client/travel';
import { botByName, newMemory, type BotName } from '../../src/engine/sim/bots';
import type { GameState, LogMessage, PlayerAction, Pos } from '../../src/engine/types';
import type { WorldSpec } from '../../src/schema/world';

const FILE = join(__dirname, 'session-characterization.jsonl');
const STEPS = 300;

interface Case {
  world: string;
  seed: number;
  bot: BotName;
}

const CASES: Case[] = [
  { world: 'fixture-western.json', seed: 11, bot: 'talker' },
  { world: 'fixture-western.json', seed: 12, bot: 'explorer' },
  { world: 'fixture-ship.json', seed: 21, bot: 'talker' },
  { world: 'fixture-teen.json', seed: 31, bot: 'cautious' },
  { world: 'fixture-dream.json', seed: 41, bot: 'talker' },
  { world: 'fixture-teen.json', seed: 32, bot: 'newbie' },
];

/** FNV-1a over a string (a log fingerprint per step) */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const logLine = (m: LogMessage) => `${m.turn}|${m.kind}|${m.speaker ?? ''}|${m.key ?? ''}|${m.text}`;

/** the lines of `now` after the last line of `prev` (the engine trims the log from the front) */
function newLines(prev: readonly LogMessage[], now: readonly LogMessage[]): string[] {
  if (!prev.length) return now.map(logLine);
  const last = logLine(prev[prev.length - 1]);
  for (let i = now.length - 1; i >= 0; i--) if (logLine(now[i]) === last) return now.slice(i + 1).map(logLine);
  return now.map(logLine);
}

/** a seen, walkable tile far from the player (click-to-travel target), or null */
function travelTarget(s: GameSession, k: number): Pos | null {
  const st = s.state;
  const m = st.area.map;
  const seen = s.me.seen as ArrayLike<number>;
  const p = s.player().pos;
  const cands: Pos[] = [];
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      const t = m.tiles[y * m.width + x];
      if (!seen[y * m.width + x] || !t || (t.kind !== 'floor' && t.kind !== 'door_open' && t.kind !== 'transition')) continue;
      if (Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) >= 5) cands.push({ x, y });
    }
  }
  return cands.length ? cands[(k * 7919) % cands.length] : null;
}

/** one bot decision through the UI calls the controller makes */
function dispatch(s: GameSession, a: PlayerAction, replies: { n: number }): { via: string; out: Outcome } {
  const pc = s.me.pendingChoice;
  if (pc?.kind === 'dialogue') {
    if (a.type === 'persuade') return { via: 'persuade', out: s.intent({ type: 'persuade', targetId: a.targetId }) };
    if (a.type === 'choose_option') {
      const m = dialogueMap(pc);
      if (++replies.n > 6) return { via: 'leave(cap)', out: s.dialogueLeave() };
      const buy = m.buy.indexOf(a.index);
      if (buy >= 0) return { via: `buy ${buy}`, out: s.trade({ type: 'buy', offerIndex: buy }) };
      if (m.sell.includes(a.index)) {
        const slot = pc.options[a.index].sell?.slot;
        if (slot !== undefined) return { via: `sell ${slot}`, out: s.trade({ type: 'sell', slot }) };
      }
      if (a.index === m.leaveIndex) return { via: 'leave', out: s.dialogueLeave() };
      // the reply list as the panel shows it (the session hides heard-out options)
      const vm = s.viewModel().game?.dialogue;
      if (!vm) return { via: 'ui(no panel)', out: s.uiAction(a) };
      const ui = vm.options.length ? Math.min(a.index, vm.options.length - 1) : -1;
      if (ui < 0) return { via: 'leave(none)', out: s.dialogueLeave() };
      return { via: `reply ${ui}`, out: s.dialogueReply(ui) };
    }
  }
  replies.n = 0;
  if (a.type === 'talk') return { via: 'talk', out: s.intent({ type: 'talk' }) };
  if (a.type === 'persuade') return { via: 'persuade', out: s.intent({ type: 'persuade', targetId: a.targetId }) };
  if (a.type === 'use' && a.target === undefined) {
    const out = s.uiAction(a);
    if (s.mode === 'target') return { via: 'use+confirm', out: s.intent({ type: 'confirm_cursor' }) };
    return { via: 'use', out };
  }
  return { via: 'ui', out: s.uiAction(a) };
}

function play(world: WorldSpec, c: Case): string[] {
  const s = new GameSession({ world, worldId: c.world.replace('.json', ''), seed: c.seed, onboarding: true });
  const gm = new OfflineGmDirector();
  const bot = botByName(c.bot);
  const mem = newMemory(c.seed);
  const lines: string[] = [];
  let prevLog: readonly LogMessage[] = [];
  let prevGm = 0;
  let prevHistory = '';
  let prevNarration = '';
  const replies = { n: 0 };

  const rec = (step: string, via: string, out: Outcome | null, extra: Record<string, unknown> = {}) => {
    const st: GameState = s.state;
    const narration = s.narration ? `${s.narration.id}|${s.narration.kind}|${s.narration.title ?? ''}|${s.narration.text}` : '';
    const history = s.history.map((h) => `${h.who}:${h.text}`).join(' / ');
    const row: Record<string, unknown> = {
      step,
      via,
      turn: st.turn,
      area: st.area.index,
      ...(out ? { ch: out.changed ? 1 : 0, ac: out.areaChanged ? 1 : 0, toasts: out.toasts.map((t) => `${t.tone}:${t.text}`), ev: out.events.map((e) => e.type).join(',') } : {}),
      ...(out?.rules?.length ? { rules: out.rules.map((r) => `${r.kind}:${r.name}`) } : {}),
      ...(out?.travel ? { travel: 1 } : {}),
      ...(out?.describe !== undefined ? { describe: out.describe ? `${out.describe.pos.x},${out.describe.pos.y}` : null } : {}),
      ...(narration !== prevNarration ? { narration } : {}),
      ...(history !== prevHistory ? { history } : {}),
      trade: s.tradeOpen ? 1 : 0,
      mode: s.mode,
      onb: `${s.onboardingOn ? 1 : 0}${s.onboardingVisible() ? 1 : 0}`,
      log: newLines(prevLog, st.log),
      logHash: fnv(st.log.map(logLine).join('\n')),
      ...(s.gmLog.length !== prevGm ? { gmLog: s.gmLog.slice(prevGm).map(logLine) } : {}),
      voiceLine: s.voiceLine(),
      ...extra,
    };
    prevLog = st.log;
    prevGm = s.gmLog.length;
    prevHistory = history;
    prevNarration = narration;
    lines.push(JSON.stringify(row));
  };

  /** the offline GM answers the session's hooks, as the controller's runner would (held while a choice is open) */
  const pumpGm = (step: number) => {
    for (const h of s.takeHooks()) {
      if (h.area !== s.state.area.index) continue;
      const res = gm.respondSync({ ...h, ctx: s.gmContext() });
      const clean = res ? sanitizeResponse(res) : null;
      if (!clean) continue;
      if (clean.actions.some((a) => a.type === 'offer_choice' || a.type === 'trade') && (s.me.pendingChoice || s.me.pendingPerkChoice)) continue;
      const out = s.applyGm(clean.actions, { hook: h.hook, area: h.area });
      rec(`${step}.gm`, `gm ${h.hook}`, out);
    }
  };

  /** NPC voice: every other request gets a canned answer */
  const pumpVoice = (step: number) => {
    const req = s.takeVoiceRequest();
    if (!req) return;
    const voice = `${req.token}|${req.npcId}|${req.playerLine ?? ''}|${req.history.map((h) => `${h.speaker}:${h.text}`).join(' / ')}`;
    if (req.token % 2 === 0) {
      const out = s.setVoice(req.token, { reply: `Voice line ${req.token}.`, actions: [] });
      rec(`${step}.voice`, 'voice', out, { voice });
    } else rec(`${step}.voice`, 'voice-unanswered', null, { voice });
  };

  rec('start', 'start', null);
  for (let i = 0; i < STEPS && !s.ended; i++) {
    pumpGm(i);
    pumpVoice(i);
    if (i === 3 && s.narration) s.dismissNarration(s.narration.id);
    if (i === 60) s.dismissOnboarding();
    if (i === 120) s.showOnboarding();
    // click-to-travel every 25 steps when nothing needs an answer and no hostile is in view
    if (i % 25 === 24 && !s.me.pendingChoice && !s.me.pendingPerkChoice && visibleHostiles(s.state).size === 0) {
      const dest = travelTarget(s, i);
      if (dest) {
        const out = s.intent({ type: 'click_tile', pos: dest, button: 'primary' });
        rec(`${i}.click`, `click ${dest.x},${dest.y}`, out);
        for (let k = 0; out.travel && k < 40; k++) {
          const t = s.travelTick();
          rec(`${i}.travel${k}`, t.more ? 'travel' : 'travel-stop', t.outcome);
          if (!t.more) break;
        }
        continue;
      }
    }
    const a = bot.decide(s.state, world, mem);
    const { via, out } = dispatch(s, a, replies);
    rec(String(i), `${via} ${JSON.stringify(a)}`, out);
  }
  pumpGm(STEPS);
  return lines;
}

describe('single-player session characterization (MP3 D2)', () => {
  it('six bot runs through the UI calls record exactly as committed', () => {
    const out: string[] = [];
    for (const c of CASES) {
      out.push(JSON.stringify({ case: `${c.world} seed ${c.seed} ${c.bot}` }));
      out.push(...play(loadFixture(c.world), c));
    }
    const text = out.join('\n') + '\n';
    if (process.env.UPDATE_CHARACTERIZATION) writeFileSync(FILE, text);
    const want = readFileSync(FILE, 'utf8');
    if (text !== want) {
      const a = text.split('\n');
      const b = want.split('\n');
      const i = a.findIndex((l, k) => l !== b[k]);
      expect({ line: i + 1, got: a[i] }).toEqual({ line: i + 1, got: b[i] });
    }
    expect(text === want).toBe(true);
  }, 120_000);
});
