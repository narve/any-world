import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../../src/client/i18n';
import {
  createMusicPanel,
  isSoundcloudUrl,
  musicPanelModel,
  soundcloudEmbedUrl,
  soundcloudSearchUrl,
  type PanelAudio,
} from '../../src/client/audio/music-panel';
import { AUDIO_MESSAGES } from '../../src/client/audio/messages';

// ---------------------------------------------------------------------------
// a tiny DOM stand-in: enough for the panel (createElement, attributes, text, events)
// ---------------------------------------------------------------------------

class FEl {
  children: FEl[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  className = '';
  value = '';
  checked = false;
  id = '';
  parent: FEl | null = null;
  private text = '';
  constructor(public tagName: string) {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  appendChild(c: FEl) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join(' ');
  }
  addEventListener(t: string, fn: (ev: unknown) => void) {
    (this.listeners[t] ??= []).push(fn);
  }
  dispatch(t: string) {
    for (const fn of this.listeners[t] ?? []) fn({ preventDefault() {} });
  }
  all(tag: string): FEl[] {
    const out: FEl[] = [];
    for (const c of this.children) {
      if (c.tagName === tag) out.push(c);
      out.push(...c.all(tag));
    }
    return out;
  }
  byClass(cls: string): FEl[] {
    const out: FEl[] = [];
    for (const c of this.children) {
      if ((c.attrs.class ?? c.className).split(' ').includes(cls)) out.push(c);
      out.push(...c.byClass(cls));
    }
    return out;
  }
}

const fakeDoc = { createElement: (t: string) => new FEl(t) } as unknown as Document;

class Win {
  ls: Record<string, (() => void)[]> = {};
  addEventListener(t: string, fn: () => void) {
    (this.ls[t] ??= []).push(fn);
  }
  removeEventListener(t: string, fn: () => void) {
    this.ls[t] = (this.ls[t] ?? []).filter((f) => f !== fn);
  }
  fire(t: string) {
    for (const f of this.ls[t] ?? []) f();
  }
}

function fakeEngine(): PanelAudio & { ducked: boolean } {
  return {
    volume: 0.6,
    muted: false,
    ambience: true,
    mood: 'eerie',
    ducked: false,
    setVolume(v) {
      (this as { volume: number }).volume = v;
    },
    mute(on = true) {
      (this as { muted: boolean }).muted = on;
    },
    setAmbience(on) {
      (this as { ambience: boolean }).ambience = on;
    },
    duck(on) {
      this.ducked = on;
    },
    unlock: async () => true,
  };
}

const spec = {
  mood: 'glassy bells over a slow tide',
  searchTerms: ['dark ambient', 'Dark Ambient', 'tidal drones'],
  suggestions: ['Some Artist - Some Album', 'https://soundcloud.com/someone/sets/deep-water'],
};

afterEach(() => setLanguage('en', { persist: false }));

describe('SoundCloud helpers', () => {
  it('builds search and widget URLs', () => {
    expect(soundcloudSearchUrl(' dark ambient & rain ')).toBe('https://soundcloud.com/search?q=dark%20ambient%20%26%20rain');
    const u = soundcloudEmbedUrl('https://soundcloud.com/a/b#t=1');
    expect(u.startsWith('https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fa%2Fb&')).toBe(true);
    expect(u).toContain('auto_play=false');
  });

  it('accepts only https SoundCloud content links', () => {
    expect(isSoundcloudUrl('https://soundcloud.com/artist/track')).toBe(true);
    expect(isSoundcloudUrl('https://on.soundcloud.com/abc123')).toBe(true);
    expect(isSoundcloudUrl('http://soundcloud.com/artist/track')).toBe(false);
    expect(isSoundcloudUrl('https://soundcloud.com/search?q=x')).toBe(false);
    expect(isSoundcloudUrl('https://soundcloud.com/')).toBe(false);
    expect(isSoundcloudUrl('https://evil.example/soundcloud.com/x')).toBe(false);
    expect(isSoundcloudUrl('javascript:alert(1)')).toBe(false);
    expect(isSoundcloudUrl('not a url')).toBe(false);
  });
});

describe('musicPanelModel', () => {
  it('turns terms and suggestions into links and finds embeddable ones', () => {
    const m = musicPanelModel(spec, { soundcloud: true, online: true });
    expect(m.searchLinks.map((l) => l.label)).toEqual(['dark ambient', 'tidal drones']);
    expect(m.searchLinks[0].url).toBe('https://soundcloud.com/search?q=dark%20ambient');
    expect(m.suggestionLinks[0].url).toContain('/search?q=Some%20Artist');
    expect(m.suggestionLinks[1].url).toBe('https://soundcloud.com/someone/sets/deep-water');
    expect(m.embeddable).toEqual(['https://soundcloud.com/someone/sets/deep-water']);
    expect(m.embedAllowed).toBe(true);
  });

  it('the widget is off by default and never offered offline', () => {
    expect(musicPanelModel(spec).embedAllowed).toBe(false);
    const off = musicPanelModel(spec, { soundcloud: true, online: false });
    expect(off.embedAllowed).toBe(false);
    expect(off.offline).toBe(true);
    expect(off.searchLinks.length).toBe(2);
    expect(musicPanelModel(undefined).searchLinks).toEqual([]);
  });
});

describe('createMusicPanel', () => {
  it('renders links, controls and the "player is off" note by default', () => {
    const engine = fakeEngine();
    const p = createMusicPanel({ audio: spec, engine, doc: fakeDoc, online: () => true, win: new Win() });
    const el = p.el as unknown as FEl;
    const links = el.all('a');
    expect(links.length).toBe(4);
    for (const a of links) {
      expect(a.attrs.target).toBe('_blank');
      expect(a.attrs.rel).toContain('noopener');
    }
    expect(el.all('iframe').length).toBe(0);
    expect(el.textContent).toContain('The SoundCloud player is off');
    expect(el.textContent).toContain('Mood: eerie');
    expect(el.textContent).toContain(spec.mood);

    const mute = el.byClass('aw-music-mute')[0];
    mute.dispatch('click');
    expect(engine.muted).toBe(true);
    expect(mute.textContent).toBe('Unmute');
    expect(mute.attrs['aria-pressed']).toBe('true');
    const range = el.all('input').find((i) => i.attrs.type === 'range')!;
    range.value = '0.2';
    range.dispatch('input');
    expect(engine.volume).toBeCloseTo(0.2);
    const box = el.all('input').find((i) => i.attrs.type === 'checkbox')!;
    box.checked = false;
    box.dispatch('change');
    expect(engine.ambience).toBe(false);
    p.dispose();
  });

  it('embeds a SoundCloud link when enabled, ducks the ambience and closes again', () => {
    const engine = fakeEngine();
    const p = createMusicPanel({ audio: spec, engine, settings: { soundcloud: true }, doc: fakeDoc, online: () => true, win: new Win() });
    const el = p.el as unknown as FEl;
    const form = el.all('form')[0];
    const input = form.all('input')[0];
    expect(input.value).toBe('https://soundcloud.com/someone/sets/deep-water');
    input.value = 'https://example.com/nope';
    form.dispatch('submit');
    expect(el.textContent).toContain('That is not a SoundCloud link.');
    expect(p.playing).toBeNull();

    const form2 = el.all('form')[0];
    form2.all('input')[0].value = 'https://soundcloud.com/artist/track';
    form2.dispatch('submit');
    expect(p.playing).toBe('https://soundcloud.com/artist/track');
    expect(engine.ducked).toBe(true);
    const frame = el.all('iframe')[0];
    expect(frame.attrs.src).toContain('w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Ftrack');

    el.byClass('aw-music-close')[0].dispatch('click');
    expect(p.playing).toBeNull();
    expect(engine.ducked).toBe(false);
    expect(el.all('iframe').length).toBe(0);
    p.dispose();
  });

  it('degrades gracefully offline and recovers when the network returns', () => {
    let online = true;
    const win = new Win();
    const engine = fakeEngine();
    const p = createMusicPanel({ audio: spec, engine, settings: { soundcloud: true }, doc: fakeDoc, online: () => online, win });
    const el = p.el as unknown as FEl;
    const form = el.all('form')[0];
    form.all('input')[0].value = 'https://soundcloud.com/artist/track';
    form.dispatch('submit');
    expect(el.all('iframe').length).toBe(1);
    online = false;
    win.fire('offline');
    expect(el.all('iframe').length).toBe(0);
    expect(engine.ducked).toBe(false);
    expect(el.textContent).toContain('You are offline');
    expect(el.all('a').length).toBe(4); // links stay
    online = true;
    win.fire('online');
    expect(el.textContent).not.toContain('You are offline');
    expect(el.all('form').length).toBe(1);
    p.dispose();
    expect(win.ls.online.length).toBe(0);
  });

  it('keeps the mood line and controls in sync with the engine without rebuilding the player', () => {
    const engine = fakeEngine();
    let notify = () => {};
    engine.subscribe = (fn) => {
      notify = fn;
      return () => (notify = () => {});
    };
    const p = createMusicPanel({ audio: spec, engine, settings: { soundcloud: true }, doc: fakeDoc, online: () => true, win: new Win() });
    const el = p.el as unknown as FEl;
    const form = el.all('form')[0];
    form.all('input')[0].value = 'https://soundcloud.com/artist/track';
    form.dispatch('submit');
    const frame = el.all('iframe')[0];
    (engine as { mood: string }).mood = 'boss';
    (engine as { muted: boolean }).muted = true;
    notify();
    expect(el.byClass('aw-music-mood')[0].textContent).toBe('Mood: showdown');
    expect(el.byClass('aw-music-mute')[0].textContent).toBe('Unmute');
    expect(el.all('iframe')[0]).toBe(frame);
    p.dispose();
  });

  it('works without an engine and without suggestions', () => {
    const p = createMusicPanel({ audio: { mood: '', searchTerms: [], suggestions: [] }, doc: fakeDoc, online: () => true, win: new Win() });
    const el = p.el as unknown as FEl;
    expect(el.textContent).toContain('This world has no music suggestions.');
    expect(el.byClass('aw-music-controls').length).toBe(0);
    p.update({ audio: spec });
    expect(el.all('a').length).toBe(4);
    p.dispose();
  });

  it('speaks Norwegian bokmål and re-renders on a language change', () => {
    const p = createMusicPanel({ audio: spec, engine: fakeEngine(), doc: fakeDoc, online: () => true, win: new Win() });
    const el = p.el as unknown as FEl;
    setLanguage('nb', { persist: false });
    expect(el.all('h3')[0].textContent).toBe('Musikk');
    expect(el.textContent).toContain('Stemning: uhyggelig');
    p.dispose();
  });

  it('Norwegian has every English audio string with the same placeholders', () => {
    const en = AUDIO_MESSAGES.en;
    const nb = AUDIO_MESSAGES.nb;
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(nb[k], k).toBeTruthy();
      const ph = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
      expect(ph(nb[k]), k).toEqual(ph(en[k]));
    }
  });
});
