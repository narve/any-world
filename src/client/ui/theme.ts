/**
 * Palette → CSS custom properties. Pure colour math (testable without a DOM) plus a tiny
 * `applyTheme` that writes the variables onto an element.
 *
 * The world palette is AI-written, so nothing guarantees contrast. `themeVars` derives panel,
 * border and muted colours and nudges the text colour until it reads on the panel background.
 */
import type { PaletteView } from './viewmodel';

export const DEFAULT_PALETTE: PaletteView = {
  primary: '#6c8cff',
  secondary: '#4fb3a9',
  accent: '#f2c14e',
  danger: '#e0565b',
  ui: '#14161f',
  text: '#ecebf3',
};

export type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [128, 128, 128];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex([r, g, b]: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** linear mix: t=0 → a, t=1 → b */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** WCAG relative luminance */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1..21) */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDark(hex: string): boolean {
  return luminance(hex) < 0.18;
}

/** black or white text, whichever reads better on `bg` */
export function textOn(bg: string): string {
  return contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#ffffff' : '#111111';
}

/**
 * Move `fg` towards white or black (away from `bg`) until it reaches `min` contrast.
 * Returns `fg` unchanged if it already passes.
 */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  if (contrast(fg, bg) >= min) return fg;
  const target = isDark(bg) ? '#ffffff' : '#000000';
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const c = mix(fg, target, t);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
}

export function rgbTriplet(hex: string): string {
  return parseHex(hex).join(', ');
}

/**
 * All CSS variables the stylesheet uses. Panels are always dark-ish or light-ish depending on
 * palette.ui; text/accents are adjusted for readability on them.
 */
export function themeVars(p: PaletteView): Record<string, string> {
  const dark = isDark(p.ui);
  const panel = p.ui;
  const panel2 = mix(p.ui, dark ? '#ffffff' : '#000000', 0.06);
  const panel3 = mix(p.ui, dark ? '#ffffff' : '#000000', 0.12);
  const text = ensureContrast(p.text, panel, 7);
  const muted = ensureContrast(mix(text, panel, 0.35), panel, 4.5);
  const accent = ensureContrast(p.accent, panel, 3);
  const primary = ensureContrast(p.primary, panel, 3);
  const secondary = ensureContrast(p.secondary, panel, 3);
  const danger = ensureContrast(p.danger, panel, 3);
  const border = mix(panel, text, 0.18);
  const borderStrong = mix(panel, accent, 0.55);
  return {
    '--c-primary': primary,
    '--c-secondary': secondary,
    '--c-accent': accent,
    '--c-danger': danger,
    '--c-good': ensureContrast(mix(p.secondary, '#5fd27a', 0.6), panel, 3),
    '--c-text': text,
    '--c-muted': muted,
    '--c-panel': panel,
    '--c-panel-2': panel2,
    '--c-panel-3': panel3,
    '--c-panel-rgb': rgbTriplet(panel),
    '--c-border': border,
    '--c-border-strong': borderStrong,
    '--c-on-accent': textOn(accent),
    '--c-on-primary': textOn(primary),
    '--c-on-danger': textOn(danger),
    '--c-accent-rgb': rgbTriplet(accent),
    '--c-primary-rgb': rgbTriplet(primary),
    '--c-danger-rgb': rgbTriplet(danger),
    '--c-shadow': dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.25)',
    'color-scheme': dark ? 'dark' : 'light',
  };
}

/** a readable foreground for arbitrary item/actor colours on the panel */
export function readableOnPanel(color: string, panel: string): string {
  return ensureContrast(color, panel, 3);
}

/** write theme vars onto an element (DOM). */
export function applyTheme(el: HTMLElement, p: PaletteView): void {
  const vars = themeVars(p);
  for (const [k, v] of Object.entries(vars)) {
    if (k === 'color-scheme') el.style.colorScheme = v;
    else el.style.setProperty(k, v);
  }
}
