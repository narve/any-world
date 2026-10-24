import { defineConfig } from 'vite';

/**
 * Two builds from one client (DESIGN §4.4):
 *   - `vite build`               → dist/client, served by the Node backend (`npm start`); backend transport by default.
 *   - `vite build --mode static` → dist/static, browser-only: relative asset paths (host it anywhere, e.g. GitHub
 *                                   Pages or a sub-folder) and direct transport by default (the browser calls the LLM).
 * Dev: `npm run dev` runs the API (server/dev.ts) and this dev server together. Ports come from the environment so
 * several dev servers can run side by side: ANYWORLD_CLIENT_PORT (5173) and ANYWORLD_API_PORT (8787, the /api proxy).
 */
function envPort(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

export default defineConfig(({ mode }) => ({
  root: 'src/client',
  publicDir: '../../public',
  base: mode === 'static' ? './' : '/',
  define: {
    __ANYWORLD_DEFAULT_TRANSPORT__: JSON.stringify(mode === 'static' ? 'direct' : 'backend'),
  },
  build: {
    outDir: mode === 'static' ? '../../dist/static' : '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: envPort('ANYWORLD_CLIENT_PORT', 5173),
    proxy: { '/api': `http://localhost:${envPort('ANYWORLD_API_PORT', 8787)}` },
  },
  preview: {
    host: '0.0.0.0',
    port: envPort('ANYWORLD_CLIENT_PORT', 4173),
  },
}));
