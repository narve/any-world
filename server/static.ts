/** Static file serving for the production build (dist/client) with SPA fallback. */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.webmanifest': 'application/manifest+json',
};

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function isFile(p: string): Promise<number | null> {
  try {
    const s = await stat(p);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

function send(res: ServerResponse, method: string, path: string, size: number, cache: string): void {
  res.writeHead(200, {
    'content-type': mimeFor(path),
    'content-length': size,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(path)
    .on('error', () => res.destroy())
    .pipe(res);
}

/**
 * Serve `req` from `root`. Returns true when a response was written.
 * Paths without an extension (client routes) fall back to index.html.
 */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;
  const rootAbs = resolve(root);
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad path');
    return true;
  }
  if (pathname.includes('\0')) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad path');
    return true;
  }
  const rel = normalize(pathname).replace(/^([/\\])+/, '');
  const file = resolve(rootAbs, rel);
  if (file !== rootAbs && !file.startsWith(rootAbs + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return true;
  }
  const target = file === rootAbs ? join(rootAbs, 'index.html') : file;
  const size = await isFile(target);
  if (size !== null) {
    const immutable = rel.startsWith('assets/') || rel.startsWith(`assets${sep}`);
    send(res, method, target, size, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    return true;
  }
  // SPA fallback: client-side routes have no file extension
  if (!extname(rel)) {
    const index = join(rootAbs, 'index.html');
    const isize = await isFile(index);
    if (isize !== null) {
      send(res, method, index, isize, 'no-cache');
      return true;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Client not built: run `npm run build` first.');
    return true;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  return true;
}
