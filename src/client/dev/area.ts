/// <reference types="vite/client" />
/**
 * Dev page: renders one generated area of a fixture world with its lighting, actors and items.
 *   /dev/area.html?world=fixture-western&area=0&seed=1&step=0&zoom=13&demo=1
 *   /dev/area.html?world=fixture-dream&area=0          (synthetic dream world until content/worlds has it)
 *   /dev/area.html?world=fixture-western&backdrop=starfield&bd=0b0820&bd2=a98bff&bi=0.7&gen=islands
 *   &still=1 freezes cosmetic motion (reduce motion); see applyOverrides for every override.
 *   &quality=auto|low|high   render quality tier (Renderer.setQuality)
 *   &insets=top,right,bottom,left   CSS px covered by a pretend HUD / hotbar (shown as dim bands)
 * Touch: pinch zooms, two-finger twist rotates (attachTouchCamera), a tap highlights the tile.
 * window.__dev exposes { renderer, state, demo(), move(dx,dy) } for e2e tests.
 */
import { Renderer, attachTouchCamera, type QualitySetting } from '../render';
import { loadWorld, buildDemoState, isOpaqueTile, simpleFov } from './fixtures';
import type { GameEvent, GameState, Pos } from '../../engine/types';
import type { WorldSpec, AreaPlan } from '../../schema/world';

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
  const loaded = loadWorld(q.get('world'));
  const name = loaded.name;
  const world = applyOverrides(loaded.world, q);
  const areaIndex = Math.max(0, Math.min(world.areas.length - 1, Number(q.get('area') ?? 0) || 0));
  const seed = Number(q.get('seed') ?? 1) || 1;
  const plan = world.areas[areaIndex];
  const { state, usedMapgen, error } = await buildDemoState(world, { seed, areaIndex });

  document.title = `${plan.name} — ${world.meta.title}`;
  document.getElementById('title')!.textContent = `${world.meta.title} · ${plan.name}`;
  const sub = document.getElementById('sub')!;
  const bd = plan.backdrop ? ` · backdrop ${plan.backdrop.style}` : '';
  sub.textContent = `${name} · ${plan.generator} ${state.area.map.width}×${state.area.map.height} · ${usedMapgen ? 'mapgen' : 'dev layout'}${bd}`;
  if (error) {
    const e = document.createElement('p');
    e.className = 'err';
    e.textContent = `mapgen unavailable: ${error}`;
    document.getElementById('hud')!.appendChild(e);
  }

  const view = document.getElementById('view')!;
  const quality = (q.get('quality') ?? 'auto') as QualitySetting;
  const r = new Renderer(view, { reduceMotion: q.get('still') === '1' ? true : undefined, quality });
  const ins = (q.get('insets') ?? '').split(',').map((n) => Number(n) || 0);
  if (ins.some((n) => n > 0)) {
    const [top = 0, right = 0, bottom = 0, left = 0] = ins;
    r.setViewportInsets({ top, right, bottom, left });
    for (const [side, size] of [['top', top], ['right', right], ['bottom', bottom], ['left', left]] as const) {
      if (!size) continue;
      const band = document.createElement('div');
      band.className = `inset inset-${side}`;
      band.style[side] = '0';
      band.style[side === 'top' || side === 'bottom' ? 'height' : 'width'] = `${size}px`;
      document.body.appendChild(band);
    }
  }
  attachTouchCamera(r, view);
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
    const t = r.pick(e.clientX, e.clientY);
    r.highlightTiles(t ? [t] : []);
  });

  if (q.get('demo')) await demo();
  // give the loop a couple of frames before declaring ready (screenshots)
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  window.__dev.ready = true;
  document.body.dataset.ready = '1';
}

/**
 * Query overrides for trying looks on any world/area:
 *   backdrop=<style>&bd=<hex>&bd2=<hex>&bi=<0..1>   AreaPlan.backdrop
 *   gen=<generator>                                 AreaPlan.generator (dev layouts for islands/organic/geometric)
 *   fp=<pattern>&wp=<pattern>                       floor / wall SurfaceStyle.pattern
 *   wh=<height>                                     wall height
 */
function applyOverrides(world: WorldSpec, q: URLSearchParams): WorldSpec {
  const keys = ['backdrop', 'gen', 'fp', 'wp', 'wh'];
  if (!keys.some((k) => q.has(k))) return world;
  const hex = (v: string | null) => (v ? (v.startsWith('#') ? v : `#${v}`) : undefined);
  const areas = world.areas.map((a) => {
    const p: AreaPlan = structuredClone(a);
    const style = q.get('backdrop');
    if (style === 'none') p.backdrop = undefined;
    else if (style)
      p.backdrop = {
        style: style as NonNullable<AreaPlan['backdrop']>['style'],
        color: hex(q.get('bd')) ?? p.backdrop?.color ?? p.lighting.sky ?? '#101828',
        color2: hex(q.get('bd2')) ?? p.backdrop?.color2,
        intensity: q.has('bi') ? Number(q.get('bi')) : p.backdrop?.intensity ?? 0.6,
      };
    if (q.get('gen')) p.generator = q.get('gen') as AreaPlan['generator'];
    if (q.get('fp')) p.floor = { ...p.floor, pattern: q.get('fp') as AreaPlan['floor']['pattern'] };
    if (q.get('wp')) p.wall = { ...p.wall, pattern: q.get('wp') as AreaPlan['wall']['pattern'] };
    if (q.get('wh')) p.wall = { ...p.wall, height: Number(q.get('wh')) };
    return p;
  });
  return { ...world, areas };
}

main().catch((e) => {
  console.error(e);
  document.getElementById('title')!.textContent = 'Failed to render area';
  document.getElementById('sub')!.textContent = String(e?.stack ?? e);
});
