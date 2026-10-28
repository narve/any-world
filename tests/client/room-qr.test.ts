/**
 * MP3 D1: the lobby's QR code (src/client/room/qr.ts): the matrix of a known share link has the size
 * of its version and the three finder patterns; the SVG is one path on white with the quiet zone.
 */
import { describe, it, expect } from 'vitest';
import { QR_QUIET, qrMatrix, qrSvg } from '../../src/client/room/qr';

const LINK = 'https://any.dv8.no/?room=K7QX';

/** the 7×7 finder pattern at (r, c): dark ring, light ring, dark 3×3 centre */
function finderAt(m: boolean[][], r: number, c: number): boolean {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const ring = Math.max(Math.abs(y - 3), Math.abs(x - 3));
      if (m[r + y][c + x] !== (ring !== 2)) return false;
    }
  }
  return true;
}

describe('qr', () => {
  it('a known link: version 3 at level M (29 modules), finder patterns in three corners', () => {
    const m = qrMatrix(LINK);
    // 29 bytes in byte mode at M need version 3 (21 + 4 × 2 modules)
    expect(m.length).toBe(29);
    expect(m.every((row) => row.length === 29)).toBe(true);
    const n = m.length;
    expect(finderAt(m, 0, 0)).toBe(true);
    expect(finderAt(m, 0, n - 7)).toBe(true);
    expect(finderAt(m, n - 7, 0)).toBe(true);
    expect(finderAt(m, n - 7, n - 7)).toBe(false);
    // the timing pattern between the finders alternates
    for (let i = 8; i < n - 8; i++) expect(m[6][i]).toBe(i % 2 === 0);
    // the same text gives the same matrix
    expect(qrMatrix(LINK)).toEqual(m);
  });

  it('the SVG: viewBox with the quiet zone, white background, one dark path, an escaped label', () => {
    const svg = qrSvg(LINK, 'Room "K7QX" <link>');
    const size = 29 + 2 * QR_QUIET;
    expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`);
    expect(svg).toContain('<rect width="37" height="37" fill="#fff"/>');
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).toContain('fill="#000"');
    expect(svg).toContain('aria-label="Room &quot;K7QX&quot; &lt;link&gt;"');
    // the top-left finder starts at the quiet zone
    expect(svg).toContain(`d="M${QR_QUIET} ${QR_QUIET}h7v1h-7z`);
    // the dark modules drawn equal the matrix
    const dark = qrMatrix(LINK).flat().filter(Boolean).length;
    const drawn = [...svg.matchAll(/h(\d+)v1/g)].reduce((a, x) => a + Number(x[1]), 0);
    expect(drawn).toBe(dark);
  });
});
