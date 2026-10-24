/** ASCII rendering of an AreaMap for debugging, tests and the mapgen-ascii tool. */
import type { AreaMap, TileKind } from '../types';

const CHARS: Record<TileKind, string> = {
  floor: '.',
  wall: '#',
  door: '+',
  door_open: "'",
  void: ' ',
  water: '~',
  transition: '>',
  start: '<',
};

const REGION_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface AsciiOptions {
  /** show lamps as '*' (default true) */
  lamps?: boolean;
  /** show region ids on floor tiles instead of '.' */
  regions?: boolean;
  /** show custom terrain as the first letter of its id (default true) */
  terrain?: boolean;
}

export function renderAscii(map: AreaMap, opts: AsciiOptions = {}): string {
  const lines: string[] = [];
  for (let y = 0; y < map.height; y++) {
    let line = '';
    for (let x = 0; x < map.width; x++) {
      const t = map.tiles[y * map.width + x];
      let ch = CHARS[t.kind] ?? '?';
      if (t.kind === 'floor') {
        if (opts.terrain !== false && t.terrain) ch = t.terrain[0];
        else if (opts.regions && t.region !== undefined) ch = REGION_CHARS[t.region % REGION_CHARS.length];
      }
      if (opts.lamps !== false && t.lamp) ch = '*';
      line += ch;
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}
