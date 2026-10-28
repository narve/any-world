/**
 * `npm run dev`: the API server and the Vite dev server (which proxies /api to it) in one process.
 * Ports: API from PORT (8787), client from ANYWORLD_CLIENT_PORT (5173). PORT=0 picks a free API port;
 * the proxy always points at the port the API actually bound.
 */
import { assertSafeNode } from './node-check';
import { createServer as createViteServer } from 'vite';
import { dataDirOrExit, startServer, testTiming } from './index';

async function main(): Promise<void> {
  assertSafeNode();
  const dataDir = dataDirOrExit(process.env, '[dev]');
  const timing = testTiming(process.env);
  const api = await startServer({ rooms: { dataDir, ...(timing ? { timing } : {}) } });
  console.log(`[dev] API on http://localhost:${api.port}`);
  console.log(`[dev] LLM presets available: ${api.configuredPresets().join(', ')}`);
  console.log(`[dev] rooms in ${dataDir}`);
  const clientPort = Number(process.env.ANYWORLD_CLIENT_PORT) || 5173;
  const vite = await createViteServer({
    configFile: 'vite.config.ts',
    // ws: true carries the room WebSocket (/api/ws) through the proxy too
    server: { port: clientPort, strictPort: true, proxy: { '/api': { target: `http://localhost:${api.port}`, ws: true } } },
  });
  await vite.listen();
  vite.printUrls();
  const shutdown = async () => {
    await vite.close();
    await api.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[dev] failed to start:', e);
  process.exit(1);
});
