/**
 * Golden replay (MP1 B0): fixed bot runs on six worlds must keep producing exactly the same games.
 *
 * MP1 turns the single player into a party; a party of one must play exactly as before. Each run is
 * reduced to one fingerprint over a format-neutral projection of the state after every step (turn,
 * status, rng, actor ids / positions / hp, defeated counts; every 25 steps and at the end also the
 * log text and the fog bytes). It deliberately does not hash `serialize`, whose key layout changes
 * with the data model. When a change is meant to alter single-player play, update FINGERPRINTS and
 * say why in the commit.
 */
import { describe, it, expect } from 'vitest';
import { loadFixture } from './helpers';
import { runGame } from '../../src/engine/sim/run';
import type { GameState } from '../../src/engine/types';
import type { Difficulty } from '../../src/schema/gm';

/** the fog of the (lead) player, whatever the model keeps it in */
function fog(s: GameState): ArrayLike<number> {
  const any = s as unknown as { area: { seen?: ArrayLike<number> }; party?: string[]; players?: Record<string, { seen: ArrayLike<number> }> };
  if (any.players && any.party) return any.players[any.party[0]].seen;
  return any.area.seen ?? [];
}

/** FNV-1a, 32 bits, over a string */
function fnv(h: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function projection(s: GameState, full: boolean): string {
  const parts: string[] = [String(s.turn), s.status, s.endReason ?? '', s.rng.join(','), String(s.area.index)];
  for (const a of s.area.actors) parts.push(`${a.id}:${a.defId}:${a.pos.x},${a.pos.y}:${a.hp}/${a.maxHp}:${a.energy}`);
  parts.push(Object.entries(s.defeated).map(([k, v]) => `${k}=${v}`).join(','));
  if (full) {
    for (const m of s.log) parts.push(`${m.turn}|${m.kind}|${m.text}`);
    const seen = fog(s);
    let f = '';
    for (let i = 0; i < seen.length; i++) f += String(seen[i] ?? 0);
    parts.push(f);
  }
  return parts.join(';');
}

interface Case {
  world: string;
  seed: number;
  bot: 'explorer' | 'cautious' | 'talker' | 'newbie';
  difficulty: Difficulty;
  /** what this case covers */
  why: string;
}

const CASES: Case[] = [
  { world: 'fixture-ship.json', seed: 3, bot: 'explorer', difficulty: 'normal', why: 'fatal resource (oxygen), GM offers' },
  { world: 'fixture-dream.json', seed: 5, bot: 'cautious', difficulty: 'normal', why: 'two fatal resources, sneaking' },
  { world: 'fantasy-retired-mimic.json', seed: 7, bot: 'explorer', difficulty: 'hard', why: 'uniques (bosses)' },
  { world: 'detective-sugar-hotel.json', seed: 11, bot: 'talker', difficulty: 'normal', why: 'dialogues, trades, uniques' },
  { world: 'fixture-western.json', seed: 2, bot: 'newbie', difficulty: 'gentle', why: 'gentle second chance' },
  { world: 'heist-silent-vault.json', seed: 1, bot: 'newbie', difficulty: 'brutal', why: 'brutal band, a lost run' },
];

/** fingerprint per case, in CASES order */
const FINGERPRINTS: string[] = [
  'won:583:607:e6e8ff3b',
  'won:340:366:58df1628',
  'timeout:701:712:be5a85de',
  'won:672:709:74f8757c',
  'won:472:525:0e31b0f2',
  'lost:440:452:b50081ff',
];

function fingerprint(c: Case): string {
  const world = loadFixture(c.world);
  let h = 0x811c9dc5;
  let steps = 0;
  let last: GameState | null = null;
  const r = runGame(world, c.seed, c.bot, {
    gm: true,
    fast: true,
    maxTurns: 700,
    difficulty: c.difficulty,
    onStep: (s) => {
      steps++;
      last = s;
      h = fnv(h, projection(s, steps % 25 === 0));
    },
  });
  if (last) h = fnv(h, projection(last, true));
  return `${r.result}:${r.turns}:${steps}:${h.toString(16).padStart(8, '0')}`;
}

describe('golden replay: single-player games stay identical', () => {
  CASES.forEach((c, i) => {
    it(`${c.world} seed ${c.seed} ${c.bot} ${c.difficulty} (${c.why})`, () => {
      const got = fingerprint(c);
      expect(got).toBe(FINGERPRINTS[i]);
    });
  });
});
