/**
 * Tiny DOM helpers: `h()` element factory, focus management and a minimal render-skipping
 * helper. No framework.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

type Handler = (ev: any) => void;

export interface Props {
  class?: string | (string | false | null | undefined)[];
  style?: string | Record<string, string | number | null | undefined>;
  dataset?: Record<string, string | number | undefined>;
  /** property assignments (value, checked, …) instead of attributes */
  props?: Record<string, unknown>;
  [attrOrHandler: string]: unknown;
}

function appendChildren(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (typeof c === 'string' || typeof c === 'number') el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c);
  }
}

export function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') {
        el.className = Array.isArray(v) ? cls(...(v as (string | false | null | undefined)[])) : String(v);
      } else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else
          for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
            if (sv === null || sv === undefined) continue;
            if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
            else (el.style as unknown as Record<string, string>)[sk] = String(sv);
          }
      } else if (k === 'dataset') {
        for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) if (dv !== undefined) el.dataset[dk] = String(dv);
      } else if (k === 'props') {
        Object.assign(el, v as object);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as Handler);
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

export function setChildren(el: Element, ...children: Child[]): void {
  el.textContent = '';
  appendChildren(el, children);
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => !e.hasAttribute('inert') && e.offsetParent !== null);
}

/**
 * Keep Tab focus inside `root` while active. Remembers the element focused before and restores
 * it on release. Initial focus: `[data-autofocus]`, else the first focusable.
 */
export function trapFocus(root: HTMLElement, opts: { initial?: boolean } = {}): () => void {
  const previous = document.activeElement as HTMLElement | null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const f = focusables(root);
    if (!f.length) {
      e.preventDefault();
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !root.contains(active))) {
      e.preventDefault();
      first.focus();
    }
    e.stopPropagation();
  };
  root.addEventListener('keydown', onKey);
  if (opts.initial !== false) focusInitial(root);
  return () => {
    root.removeEventListener('keydown', onKey);
    if (previous && document.contains(previous) && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
  };
}

export function focusInitial(root: HTMLElement): void {
  queueMicrotask(() => {
    if (root.contains(document.activeElement) && document.activeElement !== root) return;
    const target = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root)[0] ?? root;
    target.focus({ preventScroll: true });
  });
}

/** stable key for skipping re-renders when data did not change */
export function dataKey(v: unknown): string {
  return JSON.stringify(v);
}

/** svg icon from a path list (24×24 viewBox), stroke = currentColor */
export function icon(paths: readonly string[], label?: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'icon');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

export const ICONS = {
  close: ['M6 6l12 12', 'M18 6L6 18'],
  gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  shuffle: ['M16 3h5v5', 'M4 20L21 3', 'M21 16v5h-5', 'M15 15l6 6', 'M4 4l5 5'],
  help: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3', 'M12 17h.01'],
  bag: ['M6 7h12l1 13H5L6 7z', 'M9 7V5a3 3 0 0 1 6 0v2'],
  scroll: ['M8 4h11v13a3 3 0 0 1-3 3H6', 'M5 20a3 3 0 0 1-3-3V7h6', 'M12 9h4', 'M12 13h4'],
  play: ['M6 4l14 8-14 8V4z'],
  sparkle: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M6 6l2 2', 'M16 16l2 2', 'M6 18l2-2', 'M16 8l2-2'],
  check: ['M5 12l5 5L20 7'],
  dot: ['M12 12h.01'],
  lock: ['M6 11h12v10H6z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  /** camera turns anticlockwise / clockwise (touch map buttons) */
  rotateLeft: ['M3 12a9 9 0 1 0 3-6.7', 'M3 3v6h6'],
  rotateRight: ['M21 12a9 9 0 1 1-3-6.7', 'M21 3v6h-6'],
} as const;
