/**
 * `npm run dev`: the API server (port 8787) and the Vite dev server (port 5173, proxies /api to
 * 8787 per vite.config.ts) in one process.
 */
import { createServer as createViteServer } from 'vite';
import { startServer } from './index';

async function main(): Promise<void> {
  const api = await startServer();
  console.log(`[dev] API on http://localhost:${api.port}`);
  const vite = await createViteServer({ configFile: 'vite.config.ts' });
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
