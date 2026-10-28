/**
 * The engine version the page was built with (MP2 design §8): vite.config.ts and vitest.config.ts
 * define __ANYWORLD_ENGINE_VERSION__ from server/engine-version.ts. A room refuses a `hello` whose
 * version differs from the server's (refused 'outdated', reload).
 *
 * Only bundled code reads this. The server and Node tools never do: they compute the version with
 * computeEngineVersion / engineVersionFor (a tsx process has no build-time define, it would say 'dev').
 */
export const ENGINE_VERSION: string = typeof __ANYWORLD_ENGINE_VERSION__ !== 'undefined' ? __ANYWORLD_ENGINE_VERSION__ : 'dev';
