/// <reference types="vite/client" />
/**
 * The Place field of "Create a new world" (docs/PLACE-PLAN.md §5): search a real place by name or
 * use the device's location, see the map the run will start on, and pick a landmark to centre on.
 * The chosen place travels with StartOptions.place into world creation.
 *
 * The component owns its small state machine (idle → searching → hits → loading → ready | error)
 * and talks to the map services through `PlaceServices`, so tests can replace them.
 */
import { h, icon, ICONS, setChildren } from '../dom';
import { getLanguage, t } from '../../i18n/index';
import { reversePlace, searchPlace, type GeoHit } from '../../../place/geocode';
import sampleIndex from '../../../../content/places.json';
import { loadPatch, OSM_ATTRIBUTION, worldPlace } from '../../../place/load';
import { PlaceError } from '../../../place/overpass';
import { DEFAULT_EXTENT, patchSummary, type Landmark } from '../../../place/patch';
import { PlacePatch as PlacePatchSchema, type PlacePatch, type WorldPlace } from '../../../schema/place';
import { cachedPatch, cachePatch, recentPlaces, rememberPlace } from '../../place-store';

/** a place that comes with its map: needs no map service */
export interface SamplePlace {
  hit: GeoHit;
  /** a ready-made world that is set at this place (known once loaded): choosing the place plays that world on it */
  world?: string;
  load(): Promise<PlacePatch>;
}

// example places bundled with the client (content/places, built by tools/place-bundle.ts and
// tools/place-fetch.ts): their names come from the small index content/places.json (id → name, kept
// in step by tests/place/client.test.ts), so each map stays a lazy chunk
const sampleFiles = import.meta.glob('../../../../content/places/*.json', { import: 'default' }) as Record<string, () => Promise<unknown>>;
const sampleId = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '');

export function bundledSamples(): SamplePlace[] {
  return Object.keys(sampleFiles)
    .sort()
    .map((path): SamplePlace => ({
      hit: { name: (sampleIndex as Record<string, string>)[sampleId(path)] ?? sampleId(path), displayName: '', lat: 0, lon: 0, type: '' },
      async load() {
        const file = (await sampleFiles[path]!()) as GeoHit & { patch: unknown; world?: unknown };
        if (typeof file.world === 'string' && file.world) this.world = file.world;
        this.hit = { name: file.name, displayName: file.displayName, lat: file.lat, lon: file.lon, type: '' };
        return PlacePatchSchema.parse(file.patch);
      },
    }));
}

export interface PlaceServices {
  /** example places offered while nothing is chosen */
  samples?(): SamplePlace[];
  search(query: string, signal: AbortSignal): Promise<GeoHit[]>;
  reverse(lat: number, lon: number, signal: AbortSignal): Promise<GeoHit>;
  patch(hit: GeoHit, signal: AbortSignal): Promise<PlacePatch>;
  /** the device's position; rejects when the player says no or the browser has none */
  locate(): Promise<{ lat: number; lon: number }>;
  now(): string;
}

export const defaultPlaceServices: PlaceServices = {
  samples: bundledSamples,
  search: (query, signal) => searchPlace(query, { signal, language: getLanguage() }),
  reverse: (lat, lon, signal) => reversePlace(lat, lon, { signal, language: getLanguage() }),
  async patch(hit, signal) {
    const cached = cachedPatch(hit.lat, hit.lon, DEFAULT_EXTENT);
    if (cached) return { ...cached, name: hit.name.slice(0, 60) };
    const patch = await loadPatch(hit, { signal });
    cachePatch(hit.lat, hit.lon, DEFAULT_EXTENT, patch);
    return patch;
  },
  locate: () =>
    new Promise((resolve, reject) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) return reject(new Error('no geolocation'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        (e) => reject(e),
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
      );
    }),
  now: () => new Date().toISOString(),
};

type State =
  | { kind: 'idle' }
  | { kind: 'busy'; text: string }
  | { kind: 'hits'; hits: GeoHit[] }
  | { kind: 'error'; text: string }
  | { kind: 'ready'; hit: GeoHit; patch: PlacePatch; world?: string };

function errorText(e: unknown): string {
  if (e instanceof PlaceError) {
    if (e.kind === 'busy' || e.kind === 'timeout') return t('place.errBusy');
    if (e.kind === 'empty') return t('place.errEmpty');
    return t('place.errNetwork');
  }
  return t('place.errNetwork');
}

export class PlacePicker {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private searchBtn: HTMLButtonElement;
  private body: HTMLElement;
  private recentEl: HTMLElement;
  private state: State = { kind: 'idle' };
  private pending: AbortController | null = null;

  constructor(private services: PlaceServices = defaultPlaceServices, private onChange: () => void = () => {}) {
    this.input = h('input', {
      id: 'aw-place',
      class: 'aw-input aw-place-input',
      type: 'search',
      maxlength: '120',
      autocomplete: 'off',
      enterkeyhint: 'search',
      placeholder: t('place.placeholder'),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void this.search();
        }
      },
    });
    this.searchBtn = h('button', { type: 'button', class: 'aw-btn', dataset: { tip: t('place.searchTip') }, onclick: () => void this.search() }, t('place.search')) as HTMLButtonElement;
    this.body = h('div', { class: 'aw-place-body', 'aria-live': 'polite' });
    this.recentEl = h('div', { class: 'aw-place-recent' });
    this.el = h(
      'div',
      { class: 'aw-place' },
      h('label', { class: 'aw-label', for: 'aw-place' }, t('place.label'), ' ', h('span', { class: 'aw-muted' }, t('place.optional'))),
      h(
        'div',
        { class: 'aw-place-row' },
        this.input,
        this.searchBtn,
        h('button', { type: 'button', class: 'aw-btn aw-place-locate', 'aria-label': t('place.locate'), dataset: { tip: t('place.locate') }, onclick: () => void this.locate() }, icon(ICONS.target), h('span', null, t('place.locateShort'))),
      ),
      h('p', { class: 'aw-muted aw-small aw-place-note' }, t('place.note')),
      this.recentEl,
      this.body,
    );
    this.render();
  }

  /** the chosen place, ready for a world; undefined when none is chosen */
  /** the ready-made world that belongs to the chosen place (an example place with its own story) */
  world(): string | undefined {
    return this.state.kind === 'ready' ? this.state.world : undefined;
  }

  choice(): WorldPlace | undefined {
    return this.state.kind === 'ready' ? worldPlace(this.state.hit, this.state.patch, this.services.now()) : undefined;
  }

  clear(): void {
    this.pending?.abort();
    this.pending = null;
    this.set({ kind: 'idle' });
  }

  private set(state: State): void {
    this.state = state;
    this.render();
    this.onChange();
  }

  private begin(text: string): AbortSignal {
    this.pending?.abort();
    this.pending = new AbortController();
    this.set({ kind: 'busy', text });
    return this.pending.signal;
  }

  async search(): Promise<void> {
    const q = this.input.value.trim();
    if (!q) return;
    const signal = this.begin(t('place.searching'));
    try {
      const hits = await this.services.search(q, signal);
      if (signal.aborted) return;
      if (!hits.length) this.set({ kind: 'error', text: t('place.noHits', { query: q }) });
      else if (hits.length === 1) await this.choose(hits[0]!);
      else this.set({ kind: 'hits', hits });
    } catch (e) {
      if (!signal.aborted) this.set({ kind: 'error', text: errorText(e) });
    }
  }

  async locate(): Promise<void> {
    const signal = this.begin(t('place.locating'));
    let pos: { lat: number; lon: number };
    try {
      pos = await this.services.locate();
    } catch {
      if (!signal.aborted) this.set({ kind: 'error', text: t('place.errLocation') });
      return;
    }
    if (signal.aborted) return;
    try {
      const hit = await this.services.reverse(pos.lat, pos.lon, signal);
      if (!signal.aborted) await this.choose(hit);
    } catch (e) {
      if (!signal.aborted) this.set({ kind: 'error', text: errorText(e) });
    }
  }

  /** fetches the map of a place and shows it */
  async choose(hit: GeoHit): Promise<void> {
    const signal = this.begin(t('place.loading', { name: hit.name }));
    try {
      const patch = await this.services.patch(hit, signal);
      if (signal.aborted) return;
      rememberPlace(hit);
      this.input.value = hit.name;
      this.set({ kind: 'ready', hit, patch });
    } catch (e) {
      if (!signal.aborted) this.set({ kind: 'error', text: errorText(e) });
    }
  }

  /** an example place: its map comes with the client */
  async chooseSample(sample: SamplePlace): Promise<void> {
    const signal = this.begin(t('place.loading', { name: sample.hit.name }));
    try {
      const patch = await sample.load();
      if (signal.aborted) return;
      this.input.value = sample.hit.name;
      this.set({ kind: 'ready', hit: sample.hit, patch, ...(sample.world ? { world: sample.world } : {}) });
    } catch (e) {
      console.warn('[anyworld] example place failed to load:', e);
      if (!signal.aborted) this.set({ kind: 'error', text: t('place.errNetwork') });
    }
  }

  /** the same place, centred on one of its landmarks */
  private recentre(l: Landmark): void {
    if (this.state.kind !== 'ready') return;
    const base = this.state.hit;
    void this.choose({ name: l.name, displayName: `${l.name}, ${base.displayName}`.slice(0, 240), lat: l.lat, lon: l.lon, type: l.type ?? '' });
  }

  private render(): void {
    const s = this.state;
    const busy = s.kind === 'busy';
    this.searchBtn.disabled = busy;
    const recent = s.kind === 'ready' || busy ? [] : recentPlaces();
    setChildren(
      this.recentEl,
      recent.length
        ? [
            h('span', { class: 'aw-muted aw-small' }, t('place.recent')),
            ...recent.map((p) => h('button', { type: 'button', class: 'aw-tag-chip', title: p.displayName, onclick: () => void this.choose(p) }, p.name)),
          ]
        : null,
    );
    const samples = s.kind === 'ready' || busy ? [] : (this.services.samples?.() ?? []);
    if (samples.length)
      this.recentEl.append(
        h('span', { class: 'aw-muted aw-small' }, t('place.examples')),
        ...samples.map((sm) => h('button', { type: 'button', class: 'aw-tag-chip aw-place-sample', onclick: () => void this.chooseSample(sm) }, sm.hit.name)),
      );
    this.recentEl.hidden = recent.length === 0 && samples.length === 0;
    if (s.kind === 'idle') setChildren(this.body);
    else if (s.kind === 'busy') setChildren(this.body, h('p', { class: 'aw-place-status' }, h('span', { class: 'aw-spinner', 'aria-hidden': 'true' }), s.text));
    else if (s.kind === 'error') setChildren(this.body, h('p', { class: 'aw-place-status aw-place-error', role: 'alert' }, s.text));
    else if (s.kind === 'hits')
      setChildren(
        this.body,
        h('p', { class: 'aw-small aw-muted' }, t('place.pickOne')),
        h(
          'ul',
          { class: 'aw-place-hits' },
          s.hits.map((hit) => h('li', null, h('button', { type: 'button', class: 'aw-place-hit', onclick: () => void this.choose(hit) }, h('strong', null, hit.name), h('span', { class: 'aw-muted aw-small' }, hit.displayName)))),
        ),
      );
    else {
      const sum = patchSummary(s.patch);
      const canvas = h('canvas', { class: 'aw-place-map', role: 'img', 'aria-label': t('place.mapAria', { name: s.hit.name }) });
      // the preview runs the map generator: loaded when first needed, not with the start page
      const patch = s.patch;
      void import('../../place-preview')
        .then((m) => m.drawPlacePreview(canvas, patch))
        .catch((e) => console.warn('[anyworld] place preview failed:', e));
      const marks = sum.landmarks.slice(0, 10);
      setChildren(
        this.body,
        h(
          'div',
          { class: 'aw-place-chosen' },
          h(
            'div',
            { class: 'aw-place-head' },
            h('div', null, h('strong', { class: 'aw-place-name' }, s.hit.name), h('p', { class: 'aw-muted aw-small' }, s.hit.displayName)),
            h('button', { type: 'button', class: 'aw-btn aw-btn-small aw-btn-ghost', onclick: () => this.clear() }, t('place.remove')),
          ),
          h('figure', { class: 'aw-place-figure' }, canvas, h('figcaption', { class: 'aw-muted aw-small' }, t('place.caption'), ' ', OSM_ATTRIBUTION)),
          s.world ? h('p', { class: 'aw-small aw-place-world' }, t('place.hasWorld')) : null,
          sum.sparse ? h('p', { class: 'aw-place-status aw-place-warn' }, t('place.sparse')) : null,
          h('p', { class: 'aw-small' }, t('place.found', { buildings: sum.buildings, streets: sum.roads.length, trees: sum.trees })),
          sum.roads.length ? h('p', { class: 'aw-small aw-muted' }, t('place.streets', { list: sum.roads.slice(0, 8).join(', ') })) : null,
          // (re-centring fetches a new map: not offered for a place that comes with its own story)
          marks.length && !s.world
            ? h(
                'div',
                { class: 'aw-place-marks' },
                h('span', { class: 'aw-muted aw-small' }, t('place.centreOn')),
                marks.map((l) => h('button', { type: 'button', class: 'aw-tag-chip', dataset: { tip: t('place.centreTip', { name: l.name }) }, onclick: () => this.recentre(l) }, l.name)),
              )
            : null,
        ),
      );
    }
  }
}
