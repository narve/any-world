/**
 * Lazy entry to the renderer, so three.js (≈ 600 kB) is not in the first-load chunk (DESIGN §6b).
 *
 *   const { Renderer } = await loadRenderer();      // a separate chunk, fetched on first call
 *   preloadRenderer();                              // optional: start fetching early (e.g. on the start screen)
 *
 * The client keeps `import type { Renderer } from './render'` for types; only the value import moves here.
 */
type RenderModule = typeof import('./index');

let pending: Promise<RenderModule> | null = null;

export function loadRenderer(): Promise<RenderModule> {
  pending ??= import('./index').catch((e: unknown) => {
    pending = null; // allow a retry after a network hiccup
    throw e;
  });
  return pending;
}

/** Start downloading the renderer chunk without waiting for it. */
export function preloadRenderer(): void {
  void loadRenderer().catch(() => undefined);
}
