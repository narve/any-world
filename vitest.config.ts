import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { engineVersionFor } from './server/engine-version.js';

export default defineConfig({
  // the client's build-time engine version, as vite.config.ts defines it (tests/net/version.test.ts)
  define: { __ANYWORLD_ENGINE_VERSION__: JSON.stringify(engineVersionFor(process.env, fileURLToPath(new URL('.', import.meta.url)))) },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
