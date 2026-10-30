/**
 * The small music panel (DESIGN §5b, option 1 "SoundCloud"): the world's mood, the AI's search
 * terms and listening suggestions as SoundCloud links, and — only when the player enabled it in
 * settings (off by default) — an embedded SoundCloud widget for a track or playlist link. Without
 * network the links stay visible with a note and no widget is loaded; nothing here is required to
 * play. While the widget is open the generated ambience is ducked.
 *
 * The panel touches the DOM only through the injected `doc` (default: `document`), so it can be
 * tested without a browser.
 */
import type { AudioSpec } from '../../schema/world';
import { onLanguageChange } from '../i18n';
import { at, type AudioMessageKey } from './messages';
import type { MusicMood } from './theory';

export interface MusicLink {
  label: string;
  url: string;
}

export interface MusicPanelModel {
  /** the world's own mood description (free text from the world spec) */
  description: string;
  searchLinks: MusicLink[];
  suggestionLinks: MusicLink[];
  /** SoundCloud track/playlist links among the suggestions (embeddable) */
  embeddable: string[];
  /** the widget may be shown (enabled in settings and online) */
  embedAllowed: boolean;
  embedEnabled: boolean;
  offline: boolean;
}

const SC_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com']);

export function soundcloudSearchUrl(query: string): string {
  return `https://soundcloud.com/search?q=${encodeURIComponent(query.trim())}`;
}

/** an https SoundCloud link to a track, playlist or user (not a search page) */
export function isSoundcloudUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || !SC_HOSTS.has(u.hostname.toLowerCase())) return false;
  const path = u.pathname.replace(/\/+$/, '');
  return path.length > 1 && !/^\/(search|discover|upload|you|settings)(\/|$)/.test(path);
}

/** the official widget URL for a SoundCloud link (no autoplay: the player presses play) */
export function soundcloudEmbedUrl(link: string): string {
  const u = new URL(link.trim());
  u.hash = '';
  return (
    'https://w.soundcloud.com/player/?url=' +
    encodeURIComponent(u.toString()) +
    '&auto_play=false&hide_related=true&show_comments=false&show_reposts=false&visual=false'
  );
}

export function musicPanelModel(audio: Partial<AudioSpec> | undefined, opts: { soundcloud?: boolean; online?: boolean } = {}): MusicPanelModel {
  const terms = uniq((audio?.searchTerms ?? []).map((s) => s.trim()).filter(Boolean));
  const sugg = uniq((audio?.suggestions ?? []).map((s) => s.trim()).filter(Boolean));
  const embeddable = sugg.filter(isSoundcloudUrl);
  const online = opts.online !== false;
  return {
    description: (audio?.mood ?? '').trim(),
    searchLinks: terms.map((t) => ({ label: t, url: soundcloudSearchUrl(t) })),
    suggestionLinks: sugg.map((s) => (isSoundcloudUrl(s) ? { label: s.replace(/^https:\/\/(www\.)?/, ''), url: s } : { label: s, url: soundcloudSearchUrl(s) })),
    embeddable,
    embedEnabled: !!opts.soundcloud,
    embedAllowed: !!opts.soundcloud && online,
    offline: !online,
  };
}

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** the subset of the GameAudio API the panel drives (see ./index.ts) */
export interface PanelAudio {
  readonly volume: number;
  readonly muted: boolean;
  readonly ambience: boolean;
  readonly mood: MusicMood;
  setVolume(v: number): void;
  mute(on?: boolean): void;
  setAmbience(on: boolean): void;
  duck(on: boolean): void;
  unlock(): Promise<boolean>;
  /** called after mood / mute / volume / ambience changes; returns an unsubscribe function */
  subscribe?(fn: () => void): () => void;
}

export interface MusicPanelOptions {
  audio?: Partial<AudioSpec>;
  /** player settings: `soundcloud` enables the embedded widget (default off) */
  settings?: { soundcloud?: boolean };
  /** the live audio engine, for the mute / volume / ambience controls (omit for links only) */
  engine?: PanelAudio;
  /**
   * show the panel's own mute / volume / ambience controls (default true). The game turns them off:
   * the settings dialog's saved controls stand in for them, so a choice there survives a reload.
   */
  mixer?: boolean;
  doc?: Document;
  /** network state (default: navigator.onLine) */
  online?: () => boolean;
  /** events source for 'online'/'offline' (default: window, if any) */
  win?: { addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void };
}

export interface MusicPanel {
  el: HTMLElement;
  /** re-render (after settings, world or network changes) */
  update(opts?: Partial<Pick<MusicPanelOptions, 'audio' | 'settings'>>): void;
  /** the embedded player's link, if one is open */
  readonly playing: string | null;
  dispose(): void;
}

export function createMusicPanel(opts: MusicPanelOptions = {}): MusicPanel {
  const doc = opts.doc ?? document;
  const online = opts.online ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const win: MusicPanelOptions['win'] = opts.win ?? (typeof window === 'undefined' ? undefined : window);
  let audio = opts.audio;
  let settings = opts.settings ?? {};
  let playing: string | null = null;
  let error = false;
  /** in-place refresh of the live parts (mood line, controls) without rebuilding the widget */
  let refresh: () => void = () => undefined;

  const el = doc.createElement('section');
  el.className = 'aw-music-panel';
  injectStyles(doc);

  function node<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function linkList(links: MusicLink[]): HTMLElement {
    const ul = node('ul', { class: 'aw-music-links' });
    for (const l of links) {
      const li = node('li');
      const a = node('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': at('audio.panel.newTab', { label: l.label }) }, l.label);
      li.appendChild(a);
      ul.appendChild(li);
    }
    return ul;
  }

  let controlsRefresh: () => void = () => undefined;

  function controls(engine: PanelAudio): HTMLElement {
    const box = node('div', { class: 'aw-music-controls' });
    const muteLabel = (): AudioMessageKey => (engine.muted ? 'audio.panel.unmute' : 'audio.panel.mute');
    const muteBtn = node('button', { type: 'button', class: 'aw-music-mute', 'aria-pressed': String(engine.muted) }, at(muteLabel()));
    muteBtn.addEventListener('click', () => {
      void engine.unlock();
      engine.mute(!engine.muted);
      muteBtn.textContent = at(muteLabel());
      muteBtn.setAttribute('aria-pressed', String(engine.muted));
    });
    box.appendChild(muteBtn);

    const volLabel = node('label', { class: 'aw-music-volume' });
    volLabel.appendChild(node('span', {}, at('audio.panel.volume')));
    const vol = node('input', { type: 'range', min: '0', max: '1', step: '0.05', 'aria-label': at('audio.panel.volume') });
    vol.value = String(engine.volume);
    vol.addEventListener('input', () => {
      void engine.unlock();
      engine.setVolume(Number(vol.value));
    });
    volLabel.appendChild(vol);
    box.appendChild(volLabel);

    const ambLabel = node('label', { class: 'aw-music-ambience' });
    const amb = node('input', { type: 'checkbox' });
    amb.checked = engine.ambience;
    amb.addEventListener('change', () => {
      void engine.unlock();
      engine.setAmbience(amb.checked);
    });
    ambLabel.appendChild(amb);
    ambLabel.appendChild(node('span', {}, at('audio.panel.ambience')));
    box.appendChild(ambLabel);
    controlsRefresh = () => {
      muteBtn.textContent = at(muteLabel());
      muteBtn.setAttribute('aria-pressed', String(engine.muted));
      vol.value = String(engine.volume);
      amb.checked = engine.ambience;
    };
    return box;
  }

  function embedSection(m: MusicPanelModel): HTMLElement {
    const box = node('div', { class: 'aw-music-embed' });
    if (!m.embedEnabled) {
      box.appendChild(node('p', { class: 'aw-music-note' }, at('audio.panel.embedOff')));
      return box;
    }
    if (!m.embedAllowed) return box; // offline: the offline note already says why
    if (playing) {
      const frame = node('iframe', {
        src: soundcloudEmbedUrl(playing),
        title: at('audio.panel.playerTitle'),
        width: '100%',
        height: '166',
        allow: 'autoplay',
        loading: 'lazy',
        referrerpolicy: 'no-referrer',
        style: 'border:0',
      });
      box.appendChild(frame);
      const close = node('button', { type: 'button', class: 'aw-music-close' }, at('audio.panel.close'));
      close.addEventListener('click', () => {
        playing = null;
        opts.engine?.duck(false);
        render();
      });
      box.appendChild(close);
      return box;
    }
    const form = node('form', { class: 'aw-music-form' });
    const input = node('input', { type: 'url', inputmode: 'url', placeholder: 'https://soundcloud.com/…', 'aria-label': at('audio.panel.paste') });
    input.value = m.embeddable[0] ?? '';
    const play = node('button', { type: 'submit' }, at('audio.panel.play'));
    form.appendChild(input);
    form.appendChild(play);
    form.addEventListener('submit', (ev: Event) => {
      ev.preventDefault?.();
      const v = String(input.value ?? '').trim();
      if (!isSoundcloudUrl(v)) {
        error = true;
        render();
        return;
      }
      error = false;
      playing = v;
      opts.engine?.duck(true);
      render();
    });
    box.appendChild(form);
    if (error) box.appendChild(node('p', { class: 'aw-music-error', role: 'alert' }, at('audio.panel.badUrl')));
    return box;
  }

  function render(): void {
    const m = musicPanelModel(audio, { soundcloud: settings.soundcloud, online: online() });
    if (!m.embedAllowed && playing) {
      playing = null;
      opts.engine?.duck(false);
    }
    el.textContent = '';
    el.appendChild(node('h3', {}, at('audio.panel.title')));
    if (opts.engine) {
      const engine = opts.engine;
      const moodText = () => at('audio.panel.mood', { mood: at(`audio.mood.${engine.mood}` as AudioMessageKey) });
      const moodEl = node('p', { class: 'aw-music-mood', 'aria-live': 'polite' }, moodText());
      el.appendChild(moodEl);
      refresh = () => {
        const txt = moodText();
        if (moodEl.textContent !== txt) moodEl.textContent = txt;
        controlsRefresh();
      };
    }
    if (m.description) el.appendChild(node('p', { class: 'aw-music-desc' }, m.description));
    if (opts.engine && opts.mixer !== false) el.appendChild(controls(opts.engine));
    if (m.offline) el.appendChild(node('p', { class: 'aw-music-note aw-music-offline', role: 'status' }, at('audio.panel.offline')));
    if (m.searchLinks.length) {
      el.appendChild(node('h4', {}, at('audio.panel.search')));
      el.appendChild(linkList(m.searchLinks));
    }
    if (m.suggestionLinks.length) {
      el.appendChild(node('h4', {}, at('audio.panel.suggestions')));
      el.appendChild(linkList(m.suggestionLinks));
    }
    if (!m.searchLinks.length && !m.suggestionLinks.length) el.appendChild(node('p', { class: 'aw-music-note' }, at('audio.panel.nothing')));
    el.appendChild(embedSection(m));
  }

  const onNet = () => render();
  win?.addEventListener('online', onNet);
  win?.addEventListener('offline', onNet);
  const offLang = onLanguageChange(() => render());
  const offEngine = opts.engine?.subscribe?.(() => refresh()) ?? (() => undefined);
  render();

  return {
    el,
    update(next = {}) {
      if (next.audio !== undefined) audio = next.audio;
      if (next.settings !== undefined) settings = next.settings;
      render();
    },
    get playing() {
      return playing;
    },
    dispose() {
      win?.removeEventListener('online', onNet);
      win?.removeEventListener('offline', onNet);
      offLang();
      offEngine();
      if (playing) opts.engine?.duck(false);
      playing = null;
      el.textContent = '';
      el.remove?.();
    },
  };
}

/** compact default styles using the overlay's theme variables (injected once per document) */
export const MUSIC_PANEL_CSS = `
.aw-music-panel{display:flex;flex-direction:column;gap:6px;font-size:14px;color:var(--c-text,inherit);max-width:100%}
.aw-music-panel h3,.aw-music-panel h4{margin:4px 0 0}
.aw-music-panel h4{font-size:13px;color:var(--c-muted,inherit);font-weight:600}
.aw-music-desc{font-style:italic;color:var(--c-muted,inherit);margin:0}
.aw-music-mood,.aw-music-note{margin:0}
.aw-music-note{color:var(--c-muted,inherit);font-size:13px}
.aw-music-error{color:var(--c-danger,#c33);margin:0}
.aw-music-controls{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.aw-music-controls button,.aw-music-form button,.aw-music-close{min-height:44px;min-width:44px;padding:0 12px}
.aw-music-controls label{display:flex;gap:6px;align-items:center;min-height:44px}
.aw-music-controls input[type=range]{width:120px}
.aw-music-links{margin:0;padding-left:18px}
.aw-music-links li{margin:2px 0}
.aw-music-links a{color:var(--c-accent,inherit);display:inline-block;padding:6px 0;overflow-wrap:anywhere}
.aw-music-form{display:flex;gap:6px}
.aw-music-form input{flex:1;min-width:0;min-height:44px;box-sizing:border-box}
.aw-music-embed iframe{display:block;width:100%;border:0}
`;

function injectStyles(doc: Document): void {
  try {
    if (!doc.head || doc.getElementById('aw-music-panel-css')) return;
    const st = doc.createElement('style');
    st.id = 'aw-music-panel-css';
    st.textContent = MUSIC_PANEL_CSS;
    doc.head.appendChild(st);
  } catch {
    /* not a full document (tests) */
  }
}
