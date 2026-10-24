/**
 * `npm run serve:static`: serve the browser-only build (dist/static, from `npm run build:static`) with
 * a plain static file server, the way GitHub Pages or any web host would. No API, no keys: the game
 * runs with direct transport or in demo mode. Env: PORT (4173), HOST (0.0.0.0), STATIC_DIR (dist/static).
 * Also used by e2e/static-build.spec.ts.
 */
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveStatic } from './static';

export async function startStaticServer(opts: { dir?: string; port?: number; host?: string } = {}): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const dir = resolve(opts.dir ?? process.env.STATIC_DIR ?? 'dist/static');
  if (!existsSync(join(dir, 'index.html'))) throw new Error(`${dir}/index.html not found: run \`npm run build:static\` first`);
  const server = createServer((req, res) => {
    serveStatic(req, res, dir)
      .then((done) => {
        if (!done) res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }).end('Method not allowed');
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
  });
  const port = opts.port ?? (process.env.PORT !== undefined ? Number(process.env.PORT) : 4173);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(port, host, () => {
      server.off('error', rej);
      res();
    });
  });
  const addr = server.address();
  return {
    server,
    port: typeof addr === 'object' && addr ? addr.port : port,
    close: () =>
      new Promise<void>((res) => {
        server.closeAllConnections?.();
        server.close(() => res());
      }),
  };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  startStaticServer({ dir: process.argv[2] })
    .then(({ port }) => console.log(`[static] AnyWorld (browser-only build) on http://localhost:${port}`))
    .catch((e) => {
      console.error('[static] failed to start:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
