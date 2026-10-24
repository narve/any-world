/// <reference types="vite/client" />
/**
 * Dev page: renders one generated area of a fixture world with its lighting, actors and items.
 *   /dev/area.html?world=fixture-western&area=0&seed=1&step=0&zoom=13&demo=1
 * window.__dev exposes { renderer, state, demo(), move(dx,dy) } for e2e tests.
 */
import { Renderer } from '../render';
import { loadWorld, buildDemoState, isOpaqueTile, simpleFov } from './fixtures';
import type { GameEvent, GameState, Pos } from '../../engine/types';

declare global {
  interface Window {
    __dev?: {
      renderer: Renderer;
      state: GameState;
      demo: () => Promise<void>;
      move: (dx: number, dy: number) => Promise<void>;
      ready: boolean;
    };
  }
}

async function main() {
  const q = new URLSearchParams(location.search);
  const { name, world } = loadWorld(q.get('world'));
  const areaIndex = Math.max(0, Math.min(world.areas.length - 1, Number(q.get('area') ?? 0) || 0));
  const seed = Number(q.get('seed') ?? 1) || 1;
  const plan = world.areas[areaIndex];
  const { state, usedMapgen, error } = await buildDemoState(world, { seed, areaIndex });

  document.title = `${plan.name} — ${world.meta.title}`;
  document.getElementById('title')!.textContent = `${world.meta.title} · ${plan.name}`;
  const sub = document.getElementById('sub')!;
  sub.textContent = `${name} · ${plan.generator} ${state.area.map.width}×${state.area.map.height} · ${usedMapgen ? 'mapgen' : 'local test map'}`;
  if (error) {
    const e = document.createElement('p');
    e.className = 'err';
    e.textContent = `mapgen unavailable: ${error}`;
    document.getElementById('hud')!.appendChild(e);
  }

  const view = document.getElementById('view')!;
  const r = new Renderer(view);
  r.setWorld(world);
  r.setArea(state.area);
  const step = Number(q.get('step') ?? 0) | 0;
  for (let i = 0; i < ((step % 4) + 4) % 4; i++) r.rotateCamera(1);
  if (q.get('zoom')) r.rig.setZoom(Number(q.get('zoom')), true);
  await r.sync(state, []);
  r.rig.settle();

  let cur = state;
  const player = () => cur.area.actors.find((a) => a.id === cur.player.actorId)!;

  const recomputeSeen = (s: GameState) => {
    const vis = simpleFov(s.area.map, world, player().pos, world.player.sight ?? 8);
    const seen = Uint8Array.from(s.area.seen as ArrayLike<number>, (v) => (v === 2 ? 1 : v));
    for (const i of vis) seen[i] = 2;
    s.area.seen = seen;
  };

  const move = async (dx: number, dy: number) => {
    const p = player();
    const to: Pos = { x: p.pos.x + dx, y: p.pos.y + dy };
    if (isOpaqueTile(cur.area.map, world, to.x, to.y) && cur.area.map.tiles[to.y * cur.area.map.width + to.x]?.kind !== 'door') return;
    const next: GameState = structuredClone(cur);
    const np = next.area.actors.find((a) => a.id === next.player.actorId)!;
    const events: GameEvent[] = [{ type: 'moved', actorId: np.id, from: { ...np.pos }, to }];
    const t = next.area.map.tiles[to.y * next.area.map.width + to.x];
    if (t.kind === 'door') t.kind = 'door_open';
    np.pos = to;
    const picked = next.area.items.findIndex((i) => i.pos.x === to.x && i.pos.y === to.y);
    if (picked >= 0) {
      const it = next.area.items.splice(picked, 1)[0];
      events.push({ type: 'item_picked', itemId: it.item.id, defId: it.item.defId });
    }
    recomputeSeen(next);
    cur = next;
    window.__dev!.state = cur;
    await r.sync(cur, events);
  };

  const demo = async () => {
    const next: GameState = structuredClone(cur);
    const p = next.area.actors.find((a) => a.id === next.player.actorId)!;
    const others = next.area.actors.filter((a) => a.id !== p.id);
    const events: GameEvent[] = [];
    const dist = (a: Pos) => Math.abs(a.x - p.pos.x) + Math.abs(a.y - p.pos.y);
    others.sort((a, b) => dist(a.pos) - dist(b.pos));
    const dmgType = world.damageTypes[0]?.id ?? 'physical';
    if (others[0]) {
      const t = others[0];
      events.push({ type: 'attacked', attackerId: p.id, targetId: t.id, hit: true, damage: 4, damageType: dmgType, ranged: dist(t.pos) > 1 });
      events.push({ type: 'damaged', actorId: t.id, amount: 4, damageType: dmgType, sourceId: p.id });
      t.hp = Math.max(1, t.hp - 4);
      const st = world.statuses[0];
      if (st) events.push({ type: 'status_applied', actorId: t.id, status: st.id });
    }
    if (others[1]) {
      const t = others[1];
      events.push({ type: 'effect', vfx: 'bolt', color: world.palette.accent, from: p.pos, to: t.pos });
      events.push({ type: 'damaged', actorId: t.id, amount: 12, damageType: world.damageTypes.at(-1)?.id ?? dmgType });
      events.push({ type: 'died', actorId: t.id, defId: t.defId, killerId: p.id });
      next.area.actors = next.area.actors.filter((a) => a.id !== t.id);
    }
    if (others[2]) {
      const t = others[2];
      events.push({ type: 'attacked', attackerId: t.id, targetId: p.id, hit: false, damage: 0, damageType: dmgType, ranged: dist(t.pos) > 1 });
    }
    events.push({ type: 'effect', vfx: 'ring', color: '#9be7ff', from: p.pos, to: p.pos, radius: 2 });
    events.push({ type: 'healed', actorId: p.id, amount: 3 });
    cur = next;
    window.__dev!.state = cur;
    await r.sync(cur, events);
  };

  window.__dev = { renderer: r, state: cur, demo, move, ready: false };

  const keys: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'q') r.rotateCamera(-1);
    else if (e.key === 'e') r.rotateCamera(1);
    else if (e.key === ' ') void demo();
    else if (keys[e.key]) {
      // movement is relative to the camera: rotate the input by the camera step
      let [dx, dy] = keys[e.key];
      for (let i = 0; i < r.cameraStep; i++) [dx, dy] = [-dy, dx];
      r.skipAnimations();
      void move(dx, dy);
    }
  });
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    r.zoom(e.deltaY / 100);
  }, { passive: false });
  view.addEventListener('click', (e) => {
    const t = r.screenToTile(e.clientX, e.clientY);
    r.highlightTiles(t ? [t] : []);
  });

  if (q.get('demo')) await demo();
  // give the loop a couple of frames before declaring ready (screenshots)
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  window.__dev.ready = true;
  document.body.dataset.ready = '1';
}

main().catch((e) => {
  console.error(e);
  document.getElementById('title')!.textContent = 'Failed to render area';
  document.getElementById('sub')!.textContent = String(e?.stack ?? e);
});
