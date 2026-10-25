/**
 * Review M5 round 2 (code): the NPC voice prompt of an nb world gets the player's replies in
 * English. GameSession.act pushes `prevChoice.options[i].label` — the ENGINE's English label
 * ("Ask what they know", "Ask for help", "Goodbye") — into the dialogue history, and
 * reopenConversation sends the same label as `playerLine`. The M4 gate made the GM context log
 * read in the world language (prompt-log.ts) so an nb prompt does not nudge the model into English,
 * but the conversation turn the LLM answers is still "Player: Ask what they know".
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GameState, Pos } from '../../../src/engine/types';
import type { WorldSpec } from '../../../src/schema/world';
import { GameSession } from '../../../src/client/session';
import { setLanguage } from '../../../src/client/i18n/index';
import { loadFixture, roomMap } from '../../engine/helpers';

const troll = loadFixture('nb-troll-direktoratet.json');

afterEach(() => setLanguage('en', { persist: false }));

function withNpc(s: GameSession, defId: string, me: Pos = { x: 5, y: 5 }, them: Pos = { x: 6, y: 5 }): string {
  const st = structuredClone(s.state) as GameState;
  const pl = st.area.actors.find((a) => a.id === st.player.actorId)!;
  pl.pos = { ...me };
  const template = st.area.actors.find((a) => a.id !== pl.id) ?? pl;
  const def = s.world.actors.find((d) => d.id === defId)!;
  const npc = { ...structuredClone(template), id: `npc-${defId}`, defId, pos: { ...them }, hp: def.stats.hp, faction: 'friendly' as const, talkedTo: false, npcUsed: [] as string[] };
  delete (npc as { allyOf?: string }).allyOf;
  st.area.actors = [pl, npc];
  s.state = st;
  return npc.id;
}

describe('NPC voice request of an nb world', () => {
  it('the player line and history sent to the LLM are in the world language, not the engine English label', () => {
    expect(troll.meta.language).toBe('nb');
    setLanguage('nb', { persist: false });
    const s = new GameSession({ world: troll as WorldSpec, worldId: 'nb-troll-direktoratet', seed: 3, map: roomMap(14, 10) });
    s.narration = null;
    const id = withNpc(s, 'fossegrimen');
    s.uiAction({ type: 'talk', targetId: id });
    s.takeVoiceRequest();
    const d = s.viewModel().game!.dialogue!;
    // the UI shows the bokmål label…
    const ask = d.options.findIndex((o) => /Spør hva de vet/.test(o));
    expect(ask).toBeGreaterThanOrEqual(0);
    s.dialogueReply(ask);
    const req = s.takeVoiceRequest();
    expect(req).toBeTruthy();
    const playerLines = [req!.playerLine ?? '', ...req!.history.filter((h) => h.speaker === 'player').map((h) => h.text)];
    // …but the LLM is told "Ask what they know"
    expect(playerLines.filter((l) => /Ask what they know/.test(l))).toEqual([]);
  });
});

describe('dialogue history shown in the nb UI', () => {
  it('the player\'s own past reply in the dialogue panel is in the UI language', () => {
    setLanguage('nb', { persist: false });
    const s = new GameSession({ world: troll as WorldSpec, worldId: 'nb-troll-direktoratet', seed: 3, map: roomMap(14, 10) });
    s.narration = null;
    const id = withNpc(s, 'fossegrimen');
    s.uiAction({ type: 'talk', targetId: id });
    const d0 = s.viewModel().game!.dialogue!;
    s.dialogueReply(d0.options.findIndex((o) => /Spør hva de vet/.test(o)));
    const d = s.viewModel().game!.dialogue!;
    const mine = (d.history ?? []).filter((h) => h.who === 'player').map((h) => h.text);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.filter((l) => /Ask what they know/.test(l))).toEqual([]);
  });
});
