/**
 * PartyOverlay (MP3 design §3.1, §3.4, §4): a DOM layer over the map for a room's party, in the
 * MapOverlay pattern (re-projected every animation frame through the renderer, so it follows the
 * camera's smooth follow, zoom and rotation):
 *
 *  - name tags above the other players' actors on visible tiles, in the seat colour, dimmed "away",
 *    with "busy" while they are in a dialogue, a trade or a menu (the own player is not tagged);
 *  - speech bubbles over a speaker on screen (the newest line; one emote is a large frameless
 *    bubble), and the "…" typing bubble;
 *  - ping markers ("Follow me", "Wait", "Help") on their tile for a few seconds;
 *  - a coloured edge arrow with the name for a teammate (or a ping) off screen, kept clear of the
 *    HUD panels (`avoid`, placeEdgeMarker); a teammate in the fog inside the view gets a faint tag
 *    where they stand instead (the camera keeps everyone it can see on screen, so out of sight is
 *    the usual "off screen");
 *  - a pulsing help ring under a teammate who is down (they need someone next to them);
 *  - NPC lines over the NPC for nearby teammates (MP4: room/npc-bubbles.ts picks them), keyed by
 *    actor id, neutral, only while the NPC's head is on screen.
 *
 * "On screen" is: on a visible tile of the camera's state, projected inside the viewport and outside
 * every HUD rectangle. A line whose speaker is not on screen goes to the chat column instead
 * (room-ui.ts asks `onScreen`). Text is set with textContent only. Pure DOM; no three.js.
 */
import type { Pos } from '../engine/types';
import type { PingKind } from '../net/protocol';
import { edgeArrow, placeEdgeMarker, type Rect } from './map-overlay';

export interface OverlayMember {
  seat: string | null;
  name: string;
  colour: string;
  actorId: string | null;
  pos: Pos | null;
  /** on a visible tile of the camera's state */
  visible: boolean;
  you: boolean;
  away: boolean;
  busy: boolean;
  down: boolean;
  left: boolean;
}

export interface OverlayBubble {
  id: number;
  seat: string;
  text: string;
  emote: boolean;
}

export interface OverlayPing {
  id: number;
  kind: PingKind;
  label: string;
  colour: string;
  pos: Pos;
}

export interface OverlayFrame {
  members: readonly OverlayMember[];
  bubbles: readonly OverlayBubble[];
  /** seats typing now (not this player) */
  typing: ReadonlySet<string>;
  pings: readonly OverlayPing[];
  /** NPC lines to show over their NPC (MP4; absent: none) */
  npcBubbles?: readonly { actorId: string; text: string }[];
  /** HUD panels over the map (viewport rectangles) */
  avoid: readonly DOMRect[];
  /** the camera's player on screen (edge arrows start there) */
  from: { x: number; y: number } | null;
  labels: { away: string; busy: string; down: string };
}

export interface OverlayProjector {
  /** viewport point `frac` up an actor's model (null: no view, or not drawn) */
  actor(actorId: string, frac: number): { x: number; y: number } | null;
  /** viewport point of a tile centre */
  tile(p: Pos): { x: number; y: number };
}

const PING_GLYPH: Record<PingKind, string> = { follow: '➜', wait: '✋', help: '!' };
/** keep a tag or bubble this far inside the viewport to count as on screen (px) */
const INSET = 12;

type Shown = { seat: string; text: string; kind: 'bubble' | 'typing' };

export class PartyOverlay {
  readonly el: HTMLElement;
  private tags = new Map<string, HTMLElement>();
  private bubbles = new Map<string, HTMLElement>();
  private arrows = new Map<string, HTMLElement>();
  private rings = new Map<string, HTMLElement>();
  private pings = new Map<number, HTMLElement>();
  private npcs = new Map<string, HTMLElement>();
  private onScreenSeats = new Set<string>();
  private shownNow: Shown[] = [];
  private shownNpcNow: { actorId: string; text: string }[] = [];

  constructor(
    host: HTMLElement,
    private project: OverlayProjector,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'aw-party-overlay';
    this.el.setAttribute('aria-hidden', 'true');
    host.appendChild(this.el);
  }

  /** whether `seat`'s player was on screen in the last frame */
  onScreen(seat: string): boolean {
    return this.onScreenSeats.has(seat);
  }

  /** the bubbles shown in the last frame (the automation handle's bubbles()) */
  shown(): Shown[] {
    return this.shownNow.map((b) => ({ ...b }));
  }

  /** the NPC bubbles shown in the last frame (the automation handle's npcBubbles()) */
  shownNpc(): { actorId: string; text: string }[] {
    return this.shownNpcNow.map((b) => ({ ...b }));
  }

  frame(f: OverlayFrame): void {
    const r = this.el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const box = { w: r.width, h: r.height };
    const obstacles: Rect[] = f.avoid.filter((d) => d.width > 0 && d.height > 0).map((d) => ({ x: d.left - r.left - 6, y: d.top - r.top - 6, w: d.width + 12, h: d.height + 12 }));
    const local = (p: { x: number; y: number }) => ({ x: p.x - r.left, y: p.y - r.top });
    const inView = (p: { x: number; y: number }) => p.x >= INSET && p.y >= INSET && p.x <= box.w - INSET && p.y <= box.h - INSET && !obstacles.some((o) => p.x >= o.x && p.x <= o.x + o.w && p.y >= o.y && p.y <= o.y + o.h);
    const from = f.from ? local(f.from) : { x: box.w / 2, y: box.h / 2 };
    const used = { tags: new Set<string>(), bubbles: new Set<string>(), arrows: new Set<string>(), rings: new Set<string>() };
    const onScreen = new Set<string>();
    const shown: Shown[] = [];
    const bubbleBy = new Map(f.bubbles.map((b) => [b.seat, b]));

    for (const m of f.members) {
      if (!m.seat || m.left || !m.actorId || !m.pos) continue;
      const head = m.visible ? this.project.actor(m.actorId, 1.08) : null;
      // above the head; when a HUD panel covers that, under the feet (the ring stays clear of panels)
      let at = head ? local(head) : null;
      let below = false;
      if (at && !inView(at)) {
        const feet = local(this.project.tile(m.pos));
        at = inView({ x: feet.x, y: feet.y + 30 }) ? { x: feet.x, y: feet.y + 30 } : null;
        below = !!at;
      }
      const seen = !!at;
      if (seen) onScreen.add(m.seat);
      // the speech bubble (or "…") over a speaker on screen; the own player's too
      const b = bubbleBy.get(m.seat);
      const typing = !b && f.typing.has(m.seat);
      if (seen && (b || typing)) {
        const el = this.get(this.bubbles, m.seat, 'aw-bubble');
        const text = b ? b.text : '…';
        if (el.textContent !== text) el.textContent = text;
        el.classList.toggle('is-emote', !!b?.emote);
        el.classList.toggle('is-typing', typing);
        el.style.setProperty('--who', m.colour);
        // (above the name tag of a teammate; right over the head of the own player; under the feet
        // when a HUD panel would cover the bubble itself, though not the head)
        let bAt = at!;
        let bBelow = below;
        if (!below) {
          const top = at!.y - (m.you ? 6 : 24) - el.offsetHeight;
          const half = el.offsetWidth / 2;
          if (!inView({ x: at!.x - half, y: top }) || !inView({ x: at!.x + half, y: top })) {
            const feet = local(this.project.tile(m.pos));
            const under = { x: feet.x, y: feet.y + 30 };
            if (inView(under)) [bAt, bBelow] = [under, true];
          }
        }
        el.classList.toggle('is-below', bBelow);
        place(el, bAt.x, bBelow ? bAt.y + (m.you || !below ? 0 : 20) : bAt.y - (m.you ? 6 : 24));
        used.bubbles.add(m.seat);
        shown.push({ seat: m.seat, text, kind: typing ? 'typing' : 'bubble' });
      }
      if (m.you) continue;
      // a teammate down: a pulsing ring under them (someone should stand next to them)
      if (m.down) {
        const p = local(this.project.tile(m.pos));
        if (inView(p)) {
          const el = this.get(this.rings, m.seat, 'aw-help-ring');
          el.style.setProperty('--who', m.colour);
          place(el, p.x, p.y);
          used.rings.add(m.seat);
        }
      }
      const to = local(this.project.tile(m.pos));
      // in the fog but inside the view: a faint tag where they stand (the party finds each other)
      const fogged = !seen && !m.visible && inView(to);
      if (seen || fogged) {
        const el = this.get(this.tags, m.seat, 'aw-name-tag');
        const label = m.down ? f.labels.down : m.away ? f.labels.away : m.busy ? f.labels.busy : '';
        setTag(el, m.name, label);
        el.classList.toggle('is-away', m.away);
        el.classList.toggle('is-busy', m.busy && !m.away);
        el.classList.toggle('is-fogged', fogged);
        el.classList.toggle('is-below', below);
        el.style.setProperty('--who', m.colour);
        place(el, seen ? at!.x : to.x, seen ? at!.y : to.y);
        used.tags.add(m.seat);
        continue;
      }
      // off screen: an arrow at the edge pointing to them, with the name
      const arrow = edgeArrow(from, to, box, 28);
      if (!arrow) continue;
      const pl = placeEdgeMarker(arrow, to, { w: Math.min(140, 8 + m.name.length * 7), h: 18 }, obstacles, box, { top: 28, right: 28, bottom: 28, left: 28 });
      const el = this.get(this.arrows, m.seat, 'aw-edge-arrow');
      setArrow(el, m.name, pl.angle);
      el.classList.toggle('is-away', m.away);
      el.style.setProperty('--who', m.colour);
      place(el, pl.x, pl.y);
      used.arrows.add(m.seat);
    }

    // map pings: a marker on the tile, or an arrow at the edge while it is off screen
    const livePings = new Set<number>();
    for (const p of f.pings) {
      livePings.add(p.id);
      const el = this.get(this.pings, p.id, 'aw-ping');
      el.style.setProperty('--who', p.colour);
      el.dataset.kind = p.kind;
      const at = local(this.project.tile(p.pos));
      const arrow = inView(at) ? null : edgeArrow(from, at, box, 28);
      const text = `${PING_GLYPH[p.kind]} ${p.label}`;
      if (el.dataset.text !== text) {
        el.dataset.text = text;
        el.textContent = text;
      }
      el.classList.toggle('is-edge', !!arrow);
      if (arrow) {
        const pl = placeEdgeMarker(arrow, at, { w: 90, h: 22 }, obstacles, box, { top: 28, right: 28, bottom: 28, left: 28 });
        place(el, pl.x, pl.y);
      } else place(el, at.x, at.y);
    }
    for (const [id, el] of this.pings) if (!livePings.has(id)) (el.remove(), this.pings.delete(id));
    // NPC lines over the NPC's head while it is on screen
    const npcShown: { actorId: string; text: string }[] = [];
    const liveNpcs = new Set<string>();
    for (const b of f.npcBubbles ?? []) {
      const head = this.project.actor(b.actorId, 1.08);
      const at = head ? local(head) : null;
      if (!at || !inView(at)) continue;
      const el = this.get(this.npcs, b.actorId, 'aw-bubble aw-bubble-npc');
      if (el.textContent !== b.text) el.textContent = b.text;
      place(el, at.x, at.y - 6);
      liveNpcs.add(b.actorId);
      npcShown.push({ actorId: b.actorId, text: b.text });
    }
    for (const [id, el] of this.npcs) if (!liveNpcs.has(id)) (el.remove(), this.npcs.delete(id));
    for (const [k, map] of [['tags', this.tags], ['bubbles', this.bubbles], ['arrows', this.arrows], ['rings', this.rings]] as const) {
      const keep = used[k];
      for (const [seat, el] of map) if (!keep.has(seat)) (el.remove(), map.delete(seat));
    }
    this.onScreenSeats = onScreen;
    this.shownNow = shown;
    this.shownNpcNow = npcShown;
  }

  private get<K>(map: Map<K, HTMLElement>, key: K, cls: string): HTMLElement {
    let el = map.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = cls;
      this.el.appendChild(el);
      map.set(key, el);
    }
    return el;
  }

  /** nothing shown (a screen without the map) */
  clear(): void {
    for (const map of [this.tags, this.bubbles, this.arrows, this.rings, this.pings, this.npcs] as Map<unknown, HTMLElement>[]) {
      for (const el of map.values()) el.remove();
      map.clear();
    }
    this.onScreenSeats.clear();
    this.shownNow = [];
    this.shownNpcNow = [];
  }

  dispose(): void {
    this.clear();
    this.el.remove();
  }
}

function place(el: HTMLElement, x: number, y: number): void {
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
}

function setTag(el: HTMLElement, name: string, label: string): void {
  const key = `${name}|${label}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.textContent = '';
  const n = document.createElement('span');
  n.className = 'aw-name-tag-name';
  n.textContent = name;
  el.appendChild(n);
  if (label) {
    const l = document.createElement('span');
    l.className = 'aw-name-tag-label';
    l.textContent = label;
    el.appendChild(l);
  }
}

function setArrow(el: HTMLElement, name: string, angle: number): void {
  if (el.dataset.name !== name) {
    el.dataset.name = name;
    el.textContent = '';
    const tip = document.createElement('span');
    tip.className = 'aw-edge-tip';
    const n = document.createElement('span');
    n.className = 'aw-edge-name';
    n.textContent = name;
    el.append(tip, n);
  }
  (el.firstChild as HTMLElement).style.transform = `rotate(${angle.toFixed(1)}deg)`;
}
