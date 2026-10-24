/**
 * `npm run dev`: the API server and the Vite dev server (which proxies /api to it) in one process.
 * Ports: API from PORT (8787), client from ANYWORLD_CLIENT_PORT (5173). PORT=0 picks a free API port;
 * the proxy always points at the port the API actually bound.
 */
import { createServer as createViteServer } from 'vite';
import { startServer } from './index';

async function main(): Promise<void> {
  const api = await startServer();
  console.log(`[dev] API on http://localhost:${api.port}`);
  console.log(`[dev] LLM presets available: ${api.configuredPresets().join(', ')}`);
  const clientPort = Number(process.env.ANYWORLD_CLIENT_PORT) || 5173;
  const vite = await createViteServer({
    configFile: 'vite.config.ts',
    server: { port: clientPort, strictPort: true, proxy: { '/api': `http://localhost:${api.port}` } },
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
