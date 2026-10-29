/**
 * MP3 D4: a room's players in the renderer (ActorLayer, no WebGL needed): setPartyColours recolours
 * the existing faction ring of every player view (the own one included) and new views take the
 * colour; setFollow moves "the player" flag (always shown, full ring, pulse) to the followed
 * teammate's view and back. Single player never calls either: the rings keep the faction colours.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { ActorLayer, FACTION_COLORS } from './actors';
import { parseWorld } from '../../schema/refs';
import type { WorldSpec } from '../../schema/world';
import type { ActorInstance } from '../../engine/types';

function western(): WorldSpec {
  const res = parseWorld(JSON.parse(readFileSync('content/worlds/fixture-western.json', 'utf8')));
  if (!res.ok) throw new Error(res.errors.join('\n'));
  return res.world;
}

const player = (id: string, x: number): ActorInstance => ({ id, defId: 'player', pos: { x, y: 1 }, hp: 10, maxHp: 10, faction: 'player', statuses: [] }) as unknown as ActorInstance;
const hostile = (id: string): ActorInstance => ({ id, defId: 'player', pos: { x: 9, y: 9 }, hp: 5, maxHp: 5, faction: 'hostile', statuses: [] }) as unknown as ActorInstance;
const hex = (c: THREE.Color) => `#${c.getHexString()}`;
const norm = (s: string) => `#${new THREE.Color(s).getHexString()}`;

describe('party rings (setPartyColours)', () => {
  it('recolours the existing ring of each player view, own included; others keep their faction colour', () => {
    const layer = new ActorLayer(western());
    const me = layer.ensure(player('a1', 1), true);
    const mate = layer.ensure(player('a2', 2), false);
    const foe = layer.ensure(hostile('h1'), false);
    expect(hex(me.ringMat.color)).toBe(norm(FACTION_COLORS.player));
    layer.setPartyColours(new Map([['a1', '#e53950'], ['a2', '#3ba3ff']]));
    expect(hex(me.ringMat.color)).toBe(norm('#e53950'));
    expect(hex(mate.ringMat.color)).toBe(norm('#3ba3ff'));
    expect(hex(foe.ringMat.color)).toBe(norm(FACTION_COLORS.hostile));
    // the own pulse follows the seat colour; there is still one ring per actor
    expect(hex((me.pulse!.material as THREE.MeshBasicMaterial).color)).toBe(norm('#e53950'));
    expect(me.root.children.filter((c) => c === me.ring)).toHaveLength(1);
    expect(me.root.children.filter((c) => c.name === 'player-pulse')).toHaveLength(1);
    // a view made later takes its colour at once; a faction change keeps the seat colour
    const late = layer.ensure(player('a3', 3), false);
    expect(hex(late.ringMat.color)).toBe(norm(FACTION_COLORS.player));
    layer.setPartyColours(new Map([['a1', '#e53950'], ['a2', '#3ba3ff'], ['a3', '#22c55e']]));
    expect(hex(late.ringMat.color)).toBe(norm('#22c55e'));
    const later = layer.ensure(player('a4', 4), false);
    expect(hex(later.ringMat.color)).toBe(norm(FACTION_COLORS.player));
    layer.setFaction(mate, 'ally');
    expect(hex(mate.ringMat.color)).toBe(norm('#3ba3ff'));
  });
});

describe('the camera follows a teammate (setFollow)', () => {
  it('moves the player flag, the full ring and the pulse to the followed view and back', () => {
    const layer = new ActorLayer(western());
    const me = layer.ensure(player('a1', 1), true);
    const mate = layer.ensure(player('a2', 2), false);
    expect([me.isPlayer, mate.isPlayer]).toEqual([true, false]);
    expect(mate.pulse).toBeUndefined();
    expect(mate.ringMat.opacity).toBeCloseTo(0.72);
    layer.setFollow('a2');
    expect([me.isPlayer, mate.isPlayer]).toEqual([false, true]);
    expect(me.pulse).toBeUndefined();
    expect(me.root.getObjectByName('player-pulse')).toBeUndefined();
    expect(mate.pulse).toBeDefined();
    expect(mate.root.getObjectByName('player-pulse')).toBe(mate.pulse);
    expect(mate.ringMat.opacity).toBe(1);
    expect(me.ringMat.opacity).toBeCloseTo(0.72);
    expect(me.ring.scale.x).toBe(1);
    // back to this player (got up)
    layer.setFollow('a1');
    expect([me.isPlayer, mate.isPlayer]).toEqual([true, false]);
    expect(me.pulse).toBeDefined();
    expect(mate.pulse).toBeUndefined();
    // a faded view keeps its fade when re-flagged
    layer.setOpacity(mate, 0.5);
    layer.setFollow('a2');
    expect(mate.ringMat.opacity).toBeCloseTo(0.5);
  });

  it('the pulse of a followed teammate takes their seat colour', () => {
    const layer = new ActorLayer(western());
    layer.ensure(player('a1', 1), true);
    const mate = layer.ensure(player('a2', 2), false);
    layer.setPartyColours(new Map([['a2', '#3ba3ff']]));
    layer.setFollow('a2');
    expect(hex((mate.pulse!.material as THREE.MeshBasicMaterial).color)).toBe(norm('#3ba3ff'));
  });
});
