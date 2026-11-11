/**
 * Putting a world on a real place (docs/PLACE-PLAN.md, P2): attaches the place and lays the opening
 * area out on its first patch. Until the world prompt knows about places (P3) this is how a chosen
 * place reaches a run: the model's (or the recorded world's) first area keeps its dressing, actors
 * and items, and gets the real map as its layout.
 */
import type { WorldPlace } from '../schema/place';
import type { WorldSpec } from '../schema/world';

export function applyPlace(world: WorldSpec, place: WorldPlace): WorldSpec {
  const main = place.patches[0];
  if (!main) return world;
  const areas = world.areas.map((a, i) => {
    // an area that used a place before loses it unless it is the opening area
    const { patch: _old, ...rest } = a;
    if (i === 0) return { ...rest, generator: 'place' as const, patch: main.id, size: 'large' as const };
    return a.generator === 'place' ? { ...rest, generator: 'town' as const } : a;
  });
  return { ...world, areas, place };
}
