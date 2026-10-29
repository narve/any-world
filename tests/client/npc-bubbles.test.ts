/**
 * MP4 G4: NPC lines as bubbles for nearby teammates (src/client/room/npc-bubbles.ts, design §4.2)
 * and the GM's chat answers among the chat lines (GmChatLog in chat-model.ts). DOM-free.
 */
import { describe, it, expect } from 'vitest';
import { createGame } from '../../src/engine';
import type { GameState, PendingChoice, PlayerId, Pos } from '../../src/engine/types';
import { NPC_BUBBLE_MAX, NPC_BUBBLE_RANGE, NpcBubbles } from '../../src/client/room/npc-bubbles';
import { bubbleMs, GmChatLog } from '../../src/client/room/chat-model';
import { perspective } from '../../src/gm/perspective';
import { loadFixture, roomMap } from '../engine/helpers';

const western = loadFixture('fixture-western.json');

/** a 30×12 room: p1 at `p1`, p2 at `p2`, the preacher at `npc`, everything visible to both */
function room(p1: Pos, p2: Pos, npc: Pos): GameState {
  const st = structuredClone(createGame(western, { seed: 4, map: roomMap(30, 12), players: [{ name: 'Ann' }, { name: 'Bo' }] })) as GameState;
  const preacher = st.area.actors.find((a) => a.defId === 'preacher-weekes')!;
  preacher.pos = { ...npc };
  const keep = new Set([preacher.id, ...st.party.map((p) => st.players[p]!.actorId)]);
  st.area.actors = st.area.actors.filter((a) => keep.has(a.id));
  st.area.actors.find((a) => a.id === st.players.p1!.actorId)!.pos = { ...p1 };
  st.area.actors.find((a) => a.id === st.players.p2!.actorId)!.pos = { ...p2 };
  for (const pid of st.party) st.players[pid]!.seen = new Array(30 * 12).fill(2);
  return st;
}

const preacherOf = (s: GameState) => s.area.actors.find((a) => a.defId === 'preacher-weekes')!.id;

function talking(s: GameState, pid: PlayerId, prompt: string): GameState {
  const st = structuredClone(s) as GameState;
  const pc: PendingChoice = { kind: 'dialogue', prompt, speakerId: preacherOf(st), options: [{ label: 'Bye', actions: [] }] };
  st.players[pid]!.pendingChoice = pc;
  return st;
}

describe('NpcBubbles', () => {
  it("a teammate's conversation puts the NPC's line up for p1; p2 (the speaker) sees the panel instead", () => {
    const s0 = room({ x: 3, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 });
    const s1 = talking(s0, 'p2', 'Peace be with you, child.');
    const p1 = new NpcBubbles();
    p1.observe(s0, s1, 'p1', 1000);
    expect(p1.visible(perspective(s1, 'p1'), 1000)).toEqual([{ actorId: preacherOf(s1), pos: { x: 9, y: 5 }, text: 'Peace be with you, child.' }]);
    // p2's own conversation is never a bubble on p2's page
    const p2 = new NpcBubbles();
    p2.observe(s0, s1, 'p2', 1000);
    expect(p2.all(1000)).toEqual([]);
    // and a line put up for the NPC p2 talks to is not drawn there either (the panel shows it)
    p2.set(preacherOf(s1), 'a line', 1000);
    expect(p2.visible(perspective(s1, 'p2'), 1000)).toEqual([]);
  });

  it('the same prompt again does not restart the bubble; a new prompt does; it expires after bubbleMs', () => {
    const s0 = room({ x: 3, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 });
    const s1 = talking(s0, 'p2', 'Hello.');
    const b = new NpcBubbles();
    b.observe(s0, s1, 'p1', 0);
    const until = b.all(0)[0]!.until;
    expect(until).toBe(bubbleMs({ text: 'Hello.' }));
    b.observe(s1, structuredClone(s1), 'p1', 2000);
    expect(b.all(2000)[0]!.until).toBe(until);
    const s2 = talking(s1, 'p2', 'Go with God.');
    b.observe(s1, s2, 'p1', 2000);
    expect(b.all(2000)[0]).toMatchObject({ text: 'Go with God.', until: 2000 + bubbleMs({ text: 'Go with God.' }) });
    expect(b.visible(perspective(s2, 'p1'), 2000 + bubbleMs({ text: 'Go with God.' }))).toEqual([]);
    expect(b.all(1e9)).toEqual([]);
  });

  it(`shown within ${NPC_BUBBLE_RANGE} tiles of the camera player, on a visible tile, and cleared by an area change`, () => {
    const near = room({ x: 1, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 });
    const s1 = talking(near, 'p2', 'Hello.');
    const b = new NpcBubbles();
    b.observe(near, s1, 'p1', 0);
    expect(b.visible(perspective(s1, 'p1'), 1)).toHaveLength(1);
    // 9 tiles away: no bubble (the line is for nearby teammates)
    const far = structuredClone(s1) as GameState;
    far.area.actors.find((a) => a.defId === 'preacher-weekes')!.pos = { x: 10, y: 5 };
    expect(b.visible(perspective(far, 'p1'), 1)).toEqual([]);
    // remembered, not visible: no bubble
    const fog = structuredClone(s1) as GameState;
    (fog.players.p1!.seen as number[])[5 * 30 + 9] = 1;
    expect(b.visible(perspective(fog, 'p1'), 1)).toEqual([]);
    // a new area: every bubble goes
    const next = structuredClone(s1) as GameState;
    next.area.index = 1;
    b.observe(s1, next, 'p1', 2);
    expect(b.all(2)).toEqual([]);
  });

  it("a gm entry's say lines are bubbles for everyone (by actor id or def id); long lines are cut", () => {
    const s = room({ x: 3, y: 5 }, { x: 8, y: 5 }, { x: 6, y: 5 });
    const b = new NpcBubbles();
    b.gm([{ type: 'narrate', text: 'The wind turns.' }, { type: 'say', actorId: 'preacher-weekes', text: 'Repent!' }], s, 0);
    expect(b.visible(perspective(s, 'p1'), 0)).toEqual([{ actorId: preacherOf(s), pos: { x: 6, y: 5 }, text: 'Repent!' }]);
    expect(b.visible(perspective(s, 'p2'), 0)).toHaveLength(1);
    b.set(preacherOf(s), 'word '.repeat(100), 0);
    const t = b.all(0)[0]!.text;
    expect([...t].length).toBe(NPC_BUBBLE_MAX);
    expect(t.endsWith('…')).toBe(true);
    b.set('nobody', '   ', 0);
    expect(b.all(0)).toHaveLength(1);
  });
});

describe('GmChatLog', () => {
  it('places each answer after the chat line that was newest when it came, keeps words only, and caps the history', () => {
    const log = new GmChatLog();
    const chat = [{ id: 1 }, { id: 2 }, { id: 5 }];
    log.add([{ type: 'narrate', text: 'The GM hears you.' }, { type: 'mood' }, { type: 'say', actorId: 'a1', text: 'Aye.' }, { type: 'give_item' }], 2, (id) => (id === 'a1' ? 'Mags' : null));
    log.add([{ type: 'narrate', text: '  ' }], 5, () => null);
    log.add([{ type: 'narrate', text: 'Later.' }], 5, () => null);
    const merged = log.merge(chat, (g) => ({ id: g.id, name: g.name, text: g.text }));
    expect(merged.map((x) => x.id)).toEqual([1, 2, -1, -2, 5, -3]);
    expect(merged[3]).toEqual({ id: -2, name: 'Mags', text: 'Aye.' });
    expect(merged[2]).toMatchObject({ name: null });
    for (let i = 0; i < 30; i++) log.add([{ type: 'narrate', text: `n${i}` }], 5, () => null);
    expect(log.lines).toHaveLength(20);
    expect(log.lines.at(-1)!.text).toBe('n29');
  });
});
