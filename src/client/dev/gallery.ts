/// <reference types="vite/client" />
/**
 * Dev page: every actor, item, terrain and transition model of a fixture world in a labelled grid.
 *   /dev/gallery.html?world=fixture-western
 */
import * as THREE from 'three';
import { buildModel, animateModel } from '../render/models';
import { loadWorld } from './fixtures';
import type { ModelSpec } from '../../schema/world';
import { itemFit } from '../render/items';

interface Cell {
  label: string;
  sub: string;
  spec: ModelSpec;
  kind: 'actor' | 'item' | 'terrain' | 'transition';
  tint?: string;
}

function main() {
  const q = new URLSearchParams(location.search);
  const { name, world } = loadWorld(q.get('world'));
  document.title = `Models — ${world.meta.title}`;
  document.getElementById('title')!.textContent = `${world.meta.title} — models (${name})`;

  const sections: { title: string; cells: Cell[] }[] = [
    {
      title: 'Characters',
      cells: [
        { label: world.player.name, sub: 'player', spec: world.player.model, kind: 'actor' },
        ...world.actors.map((a) => ({ label: a.name, sub: `${a.faction}${a.npc ? ' · ' + a.npc.role : ''}`, spec: a.model, kind: 'actor' as const })),
      ],
    },
    {
      title: 'Items',
      cells: world.items.map((i) => ({ label: i.name, sub: i.kind, spec: i.model, kind: 'item' as const })),
    },
    {
      title: 'Terrain & transitions',
      cells: [
        ...world.terrains.filter((t) => t.model).map((t) => ({ label: t.name, sub: 'terrain', spec: t.model!, kind: 'terrain' as const })),
        ...world.areas.map((a, i) => ({
          label: a.transitionName,
          sub: `area ${i}`,
          spec: a.transitionModel ?? { archetype: 'freeform' as const, colors: { primary: world.palette.accent }, parts: [], scale: 1, idle: 'spin' as const },
          kind: 'transition' as const,
        })),
      ],
    },
  ];

  // ?section=characters|items|terrain shows one section only (bigger, for close review)
  const only = q.get('section');
  const shown = only ? sections.filter((s) => s.title.toLowerCase().startsWith(only.toLowerCase())) : sections;
  const COLS = Number(q.get('cols')) || (only ? Math.min(8, Math.max(4, Math.ceil(Math.sqrt(shown[0]?.cells.length ?? 1) * 1.6))) : 10);

  const view = document.getElementById('view')!;
  const labels = document.getElementById('labels')!;
  const gl = new THREE.WebGLRenderer({ antialias: true });
  gl.setPixelRatio(Math.min(2, devicePixelRatio));
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.NeutralToneMapping;
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFShadowMap;
  view.appendChild(gl.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#2b2d35');
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
  const sun = new THREE.DirectionalLight(0xfff4e6, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0xc8d8ff, 0.6);
  fill.position.set(-5, 4, 8);
  scene.add(fill);

  const DX = 1.45;
  const DZ = 1.75;
  const models: { obj: THREE.Object3D; cell: Cell; anchor: THREE.Vector3 }[] = [];
  const headers: { title: string; anchor: THREE.Vector3 }[] = [];
  let row = 0;
  for (const s of shown) {
    if (!s.cells.length) continue;
    headers.push({ title: s.title, anchor: new THREE.Vector3(-DX * 0.6, 0, row * DZ - DZ * 0.55) });
    s.cells.forEach((cell, i) => {
      const c = i % COLS;
      const r = row + Math.floor(i / COLS);
      const obj = buildModel(cell.spec, { lights: true });
      let lift = 0;
      if (cell.kind === 'item') {
        // match the in-game normalisation, shown a bit larger for inspection
        const fit = itemFit(obj);
        obj.scale.setScalar(fit.scale * 1.5);
        lift = fit.lift * 1.5;
      } else if (cell.kind === 'actor') {
        obj.scale.setScalar(1.3);
      }
      const x = c * DX;
      const z = r * DZ;
      obj.position.set(x, lift, z);
      obj.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      scene.add(obj);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.5, 0.06, 28), new THREE.MeshStandardMaterial({ color: '#4a4d58', roughness: 0.9 }));
      pad.position.set(x, -0.03, z);
      pad.receiveShadow = true;
      scene.add(pad);
      models.push({ obj, cell, anchor: new THREE.Vector3(x, 0, z + 0.55) });
    });
    row += Math.ceil(s.cells.length / COLS) + 0.35;
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#33363f', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.061;
  ground.receiveShadow = true;
  scene.add(ground);

  const width = (COLS - 1) * DX;
  const depth = (row - 0.35) * DZ;
  const centre = new THREE.Vector3(width / 2, 0, depth / 2 - DZ * 0.3);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  sun.position.set(centre.x + 6, 14, centre.z + 8);
  sun.target.position.copy(centre);
  const sc = sun.shadow.camera;
  sc.left = -width;
  sc.right = width;
  sc.top = depth;
  sc.bottom = -depth;
  sc.updateProjectionMatrix();

  const labelEls = models.map((m) => {
    const el = document.createElement('div');
    el.className = 'label';
    el.innerHTML = `${escapeHtml(m.cell.label)} <small>${escapeHtml(m.cell.sub)}</small>`;
    labels.appendChild(el);
    return el;
  });
  const headerEls = headers.map((h) => {
    const el = document.createElement('div');
    el.className = 'section';
    el.textContent = h.title;
    labels.appendChild(el);
    return el;
  });

  const resize = () => {
    const w = view.clientWidth;
    const h = view.clientHeight;
    gl.setSize(w, h);
    camera.aspect = w / h;
    // fit the grid: tilt 38° from vertical-ish, back off until both extents fit
    const pitch = (55 * Math.PI) / 180;
    const vfov = (camera.fov * Math.PI) / 180;
    const needH = depth * Math.sin(pitch) + 1.6;
    const needW = width + 1.6;
    const distH = needH / 2 / Math.tan(vfov / 2);
    const distW = needW / 2 / (Math.tan(vfov / 2) * camera.aspect);
    const dist = Math.max(distH, distW) * 1.02;
    camera.position.set(centre.x, centre.y + Math.sin(pitch) * dist, centre.z + Math.cos(pitch) * dist);
    camera.lookAt(centre.x, 0.3, centre.z);
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  const tmp = new THREE.Vector3();
  const place = (el: HTMLElement, p: THREE.Vector3) => {
    tmp.copy(p).project(camera);
    el.style.left = `${((tmp.x + 1) / 2) * view.clientWidth}px`;
    el.style.top = `${((1 - tmp.y) / 2) * view.clientHeight}px`;
  };
  let frames = 0;
  const start = performance.now();
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const t = (now - start) / 1000;
    for (const m of models) animateModel(m.obj, t);
    gl.render(scene, camera);
    models.forEach((m, i) => place(labelEls[i], m.anchor));
    headers.forEach((h, i) => place(headerEls[i], h.anchor));
    if (++frames === 3) document.body.dataset.ready = '1';
  };
  requestAnimationFrame(loop);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

try {
  main();
} catch (e) {
  console.error(e);
  document.getElementById('title')!.textContent = `Failed: ${String((e as Error)?.message ?? e)}`;
}
