/**
 * The lobby's QR code (MP3 design §2.5): the share link → an SVG with one <path>, error correction
 * M, a 4-module quiet zone, dark modules on white (also in dark themes, so every camera reads it).
 * The encoder is the qrcode-generator package (MIT, no dependencies); the lobby imports this module
 * lazily so it is not in the start bundle.
 */
import qrcode from 'qrcode-generator';

export const QR_QUIET = 4;

/** the module matrix of `text` (true = dark), rows top to bottom */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const out: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    out.push(row);
  }
  return out;
}

/** SVG markup of the QR code of `text`, scalable (viewBox in modules), with a text alternative */
export function qrSvg(text: string, label = text): string {
  const m = qrMatrix(text);
  const size = m.length + 2 * QR_QUIET;
  let d = '';
  m.forEach((row, y) => {
    // one rectangle per run of dark modules in a row
    for (let x = 0; x < row.length; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < row.length && row[x + w]) w++;
      d += `M${x + QR_QUIET} ${y + QR_QUIET}h${w}v1h-${w}z`;
      x += w;
    }
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${escapeAttr(label)}">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`
  );
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
