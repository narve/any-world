/**
 * Floor item views: small bobbing models from ItemDef.model, normalised to fit a tile, with a faint
 * halo under them. Unknown items are tinted with their per-run appearance colour.
 */
import * as THREE from 'three';
import type { WorldSpec } from '../../schema/world';
import type { FloorItem, GameState } from '../../engine/types';
import { buildModel, animateModel } from './models';
import { compactModel } from './models/merge';
import { col } from './color';
import { glowTexture } from './textures';

export interface ItemView {
  id: string;
  defId: string;
  root: THREE.Group;
  model: THREE.Object3D;
  tintKey: string;
  baseY: number;
  phase: number;
  /** being picked up: no longer reconciled */
  leaving: boolean;
}

const TARGET_EXTENT = 0.46;

/** Scale + lift that make an item model fit a tile and sit on the floor (shared with the gallery). */
export function itemFit(obj: THREE.Object3D): { scale: number; lift: number } {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return { scale: 1, lift: 0 };
  const size = box.getSize(new THREE.Vector3());
  const ext = Math.max(size.x, size.y, size.z, 0.05);
  const scale = Math.min(2.6, Math.max(0.45, TARGET_EXTENT / ext));
  return { scale, lift: -box.min.y * scale };
}

export class ItemLayer {
  readonly group = new THREE.Group();
  readonly views = new Map<string, ItemView>();
  private templates = new Map<string, { obj: THREE.Group; scale: number; lift: number }>();
  private world: WorldSpec;
  private haloMat: THREE.SpriteMaterial;

  constructor(world: WorldSpec) {
    this.world = world;
    this.group.name = 'items';
    this.haloMat = new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending });
  }

  /** tint for unknown items: their run appearance colour */
  static tintFor(state: GameState | null, defId: string): string | null {
    const k = state?.knowledge?.[defId];
    if (k && k.level === 'unknown' && k.appearance?.color) return k.appearance.color;
    return null;
  }

  private template(defId: string, tint: string | null) {
    const key = `${defId}|${tint ?? ''}`;
    let t = this.templates.get(key);
    if (!t) {
      const def = this.world.items.find((i) => i.id === defId);
      const spec = def?.model ?? { archetype: 'prop' as const, colors: { primary: '#b0a080' }, parts: [], scale: 0.6, idle: 'bob' as const };
      const obj = buildModel(spec, { lights: false, tint: tint ? { color: tint, strength: 0.7 } : undefined });
      // rigid parts merged per material: a floor item costs a draw call or two, not one per primitive
      compactModel(obj);
      const { scale, lift } = itemFit(obj);
      t = { obj, scale, lift };
      this.templates.set(key, t);
    }
    return t;
  }

  /** Create or update views to match the floor items; returns ids that were removed. */
  reconcile(items: FloorItem[], state: GameState | null, visible: (x: number, y: number) => boolean, keep: Set<string>): string[] {
    const present = new Set<string>();
    const perTile = new Map<string, number>();
    for (const fi of items) {
      const id = fi.item.id;
      present.add(id);
      const tileKey = `${fi.pos.x},${fi.pos.y}`;
      const n = perTile.get(tileKey) ?? 0;
      perTile.set(tileKey, n + 1);
      const tint = ItemLayer.tintFor(state, fi.item.defId);
      const tintKey = tint ?? '';
      let v = this.views.get(id);
      if (v && v.tintKey !== tintKey) {
        this.removeView(id);
        v = undefined;
      }
      if (!v) v = this.create(id, fi.item.defId, tint);
      if (v.leaving) continue;
      // fan out stacked items on the same tile
      const off = n === 0 ? [0, 0] : [Math.cos(n * 2.1) * 0.22, Math.sin(n * 2.1) * 0.22];
      v.root.position.set(fi.pos.x + off[0], 0, fi.pos.y + off[1]);
      v.root.visible = visible(fi.pos.x, fi.pos.y);
    }
    const removed: string[] = [];
    for (const [id, v] of this.views) {
      if (!present.has(id) && !v.leaving && !keep.has(id)) {
        this.removeView(id);
        removed.push(id);
      }
    }
    return removed;
  }

  private create(id: string, defId: string, tint: string | null): ItemView {
    const t = this.template(defId, tint);
    const model = t.obj.clone();
    model.scale.setScalar(t.scale);
    const root = new THREE.Group();
    root.name = `item:${id}`;
    const halo = new THREE.Sprite(this.haloMat);
    halo.scale.set(0.7, 0.7, 0.7);
    halo.position.y = 0.12;
    halo.renderOrder = 1;
    if (tint) {
      const hm = this.haloMat.clone();
      hm.color = col(tint);
      hm.opacity = 0.35;
      halo.material = hm;
    }
    root.add(halo);
    root.add(model);
    const v: ItemView = { id, defId, root, model, tintKey: tint ?? '', baseY: 0.06 + t.lift, phase: (id.length * 1.7) % 6.28, leaving: false };
    model.position.y = v.baseY;
    this.views.set(id, v);
    this.group.add(root);
    return v;
  }

  removeView(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    this.group.remove(v.root);
    v.root.traverse((o) => {
      const s = o as THREE.Sprite;
      if (s.isSprite && s.material !== this.haloMat) s.material.dispose();
    });
    this.views.delete(id);
  }

  update(t: number): void {
    for (const v of this.views.values()) {
      if (!v.root.visible || v.leaving) continue;
      v.model.position.y = v.baseY + 0.05 + Math.sin(t * 2.2 + v.phase) * 0.05;
      animateModel(v.model, t);
    }
  }

  dispose(): void {
    for (const id of [...this.views.keys()]) this.removeView(id);
    this.haloMat.dispose();
    // merged geometries belong to the templates (unit primitives are shared and stay)
    for (const t of this.templates.values())
      t.obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !m.geometry.userData.shared) m.geometry.dispose();
      });
    this.templates.clear();
  }
}
