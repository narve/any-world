import { defineConfig } from 'vite';

// `vite build --mode static` produces a browser-only build (direct LLM transport by default).
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
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
}));
