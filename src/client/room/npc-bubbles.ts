/**
 * NPC lines as bubbles over the NPC for nearby teammates (MP4 design §4.2), DOM-free: one line per
 * NPC (the newest), shown for a time that grows with its length (chat-model's bubbleMs). Sources:
 *
 *  (a) a teammate's conversation opened or moved on in the replica: that NPC's canned line (the
 *      prompt the teammate sees);
 *  (b) the server's `npc` voice line for a teammate's conversation: replaces (a);
 *  (c) a gm entry's `say` actions: the actor's line, for everyone.
 *
 * `visible` gives the bubbles to draw: the NPC on a visible tile of the camera's state, within
 * NPC_BUBBLE_RANGE tiles of the camera's player, and not the NPC this player is talking to (the
 * dialogue panel shows that line). An area change clears every bubble. Text is plain (the overlay
 * sets it with textContent).
 */
import type { GameState, PlayerId, Pos } from '../../engine/types';
import { leadPlayer } from '../../engine/index';
import type { GmAction } from '../../schema/gm';
import { codePoints } from '../../net/protocol';
import { bubbleMs } from './chat-model';

/** NPC bubbles show for a camera player at most this many tiles away (Chebyshev) */
export const NPC_BUBBLE_RANGE = 8;
/** a bubble shows at most this many code points (the rest is cut with "…") */
export const NPC_BUBBLE_MAX = 160;

export interface NpcBubble {
  actorId: string;
  text: string;
  until: number;
}

export interface NpcBubbleView {
  actorId: string;
  pos: Pos;
  text: string;
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (codePoints(t) <= NPC_BUBBLE_MAX) return t;
  return `${[...t].slice(0, NPC_BUBBLE_MAX - 1).join('').trimEnd()}…`;
}

export class NpcBubbles {
  private by = new Map<string, NpcBubble>();
  private area = -1;

  /** a line over `actorId` from `now` (an empty line is ignored) */
  set(actorId: string, text: string, now: number): void {
    const t = clip(text);
    if (!t) return;
    this.by.set(actorId, { actorId, text: t, until: now + bubbleMs({ text: t }) });
  }

  /**
   * An entry was applied (`before` → `after`, raw replica states): a new area clears every bubble;
   * a teammate's conversation that opened or moved on (speaker or prompt changed) puts its NPC's
   * line up (source a). `me`: this page's player (its own conversation is the panel).
   */
  observe(before: GameState, after: GameState, me: PlayerId, now: number): void {
    if (after.area.index !== this.area || before.area.index !== after.area.index) {
      this.area = after.area.index;
      this.by.clear();
      if (before.area.index !== after.area.index) return;
    }
    for (const pid of after.party) {
      if (pid === me) continue;
      const pc = after.players[pid]?.pendingChoice;
      if (pc?.kind !== 'dialogue' || !pc.speakerId) continue;
      const was = before.players[pid]?.pendingChoice;
      if (was?.kind === 'dialogue' && was.speakerId === pc.speakerId && was.prompt === pc.prompt) continue;
      this.set(pc.speakerId, pc.prompt, now);
    }
  }

  /** a gm entry's `say` lines (source c) */
  gm(actions: readonly GmAction[], state: GameState, now: number): void {
    for (const a of actions) {
      if (a.type !== 'say') continue;
      const id = state.area.actors.find((x) => x.id === a.actorId || x.defId === a.actorId)?.id;
      if (id) this.set(id, a.text, now);
    }
  }

  /** the bubbles to draw for the camera's state `cam` (its lead is the camera player); expired ones dropped */
  visible(cam: GameState, now: number): NpcBubbleView[] {
    const out: NpcBubbleView[] = [];
    const lead = leadPlayer(cam);
    const me = cam.area.actors.find((a) => a.id === lead.actorId)?.pos;
    const talking = lead.pendingChoice?.kind === 'dialogue' ? lead.pendingChoice.speakerId : undefined;
    const seen = lead.seen as ArrayLike<number>;
    const w = cam.area.map.width;
    for (const [id, b] of this.by) {
      if (b.until <= now) {
        this.by.delete(id);
        continue;
      }
      if (id === talking || !me) continue;
      const npc = cam.area.actors.find((a) => a.id === id);
      if (!npc || npc.hp <= 0) continue;
      if (Math.max(Math.abs(npc.pos.x - me.x), Math.abs(npc.pos.y - me.y)) > NPC_BUBBLE_RANGE) continue;
      if ((seen[npc.pos.y * w + npc.pos.x] ?? 0) !== 2) continue;
      out.push({ actorId: id, pos: { ...npc.pos }, text: b.text });
    }
    return out;
  }

  /** every bubble still up (tests, the automation handle) */
  all(now: number): NpcBubble[] {
    return [...this.by.values()].filter((b) => b.until > now);
  }

  clear(): void {
    this.by.clear();
  }
}
