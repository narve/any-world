/**
 * Dev server for the round-2 mobile playtest: the project's vite config with HMR and file watching off,
 * so other agents' edits during a long touch run never reload the page mid-run.
 */
import { defineConfig, type ConfigEnv, type UserConfig } from 'vite';
import base from '../../../vite.config';

export default defineConfig((env: ConfigEnv) => {
  const c = (typeof base === 'function' ? base(env) : base) as UserConfig;
  return { ...c, server: { ...c.server, hmr: false, watch: null } };
});
