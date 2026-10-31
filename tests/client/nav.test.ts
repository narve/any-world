import { describe, expect, it } from 'vitest';
import { Nav, type HistoryLike } from '../../src/client/nav';

/**
 * An in-memory browser history. As in a browser, back() does not move at once: the step and its
 * popstate happen later, when the test calls `pop()` (which also tells the Nav, as the app's
 * popstate handler does).
 */
class FakeHistory implements HistoryLike {
  entries: { state: unknown; url: string }[];
  i = 0;
  private backs = 0;
  nav: Nav | null = null;
  constructor(url: string) {
    this.entries = [{ state: null, url }];
  }
  get state(): unknown {
    return this.entries[this.i]!.state;
  }
  get url(): string {
    return this.entries[this.i]!.url;
  }
  pushState(data: unknown, _u: string, url?: string | URL | null): void {
    this.entries = this.entries.slice(0, this.i + 1);
    this.entries.push({ state: structuredClone(data), url: String(url ?? this.url) });
    this.i++;
  }
  replaceState(data: unknown, _u: string, url?: string | URL | null): void {
    this.entries[this.i] = { state: structuredClone(data), url: String(url ?? this.url) };
  }
  back(): void {
    this.backs++;
  }
  /** the queued step back happens; returns what the app's popstate handler would get from consumePop */
  pop(): boolean {
    expect(this.backs).toBeGreaterThan(0);
    this.backs--;
    if (this.i > 0) this.i--;
    return this.nav!.consumePop();
  }
  get queuedBacks(): number {
    return this.backs;
  }
}

const ORIGIN = 'https://any.example/';
const setup = (url = ORIGIN) => {
  const h = new FakeHistory(url);
  const nav = new Nav(h, () => h.url);
  h.nav = nav;
  return { h, nav };
};

describe('Nav', () => {
  it('start → run pushes, and going home steps back instead of stacking a start page', () => {
    const { h, nav } = setup();
    nav.push('?world=a&seed=1');
    expect(h.entries).toHaveLength(2);
    expect(h.url).toBe(`${ORIGIN}?world=a&seed=1`);
    expect(nav.state()?.fromStart).toBe(true);
    nav.home('/');
    expect(h.pop()).toBe(true);
    expect(h.url).toBe(ORIGIN);
  });

  it('a page opened straight on a run link replaces its entry when going home', () => {
    const { h, nav } = setup(`${ORIGIN}?world=a&seed=1`);
    nav.home('/');
    expect(h.queuedBacks).toBe(0);
    expect(h.entries).toHaveLength(1);
    expect(h.url).toBe(ORIGIN);
  });

  it('the loading screen is replaced by the run that follows, which still returns to the start page', () => {
    const { h, nav } = setup();
    nav.push('/', { loading: true });
    expect(nav.state()).toEqual({ aw: 1, fromStart: true, loading: true });
    nav.replace('?world=gen-1&seed=9');
    expect(h.entries).toHaveLength(2);
    expect(nav.state()).toEqual({ aw: 1, fromStart: true });
    nav.home('/');
    h.pop();
    expect(h.i).toBe(0);
  });

  it('a modal pushes an entry at the same address; closing it by its button steps back, and that pop is ours', () => {
    const { h, nav } = setup();
    nav.push('?world=a&seed=1');
    nav.openModal('help');
    nav.openModal('help'); // already open: no second entry
    expect(h.entries).toHaveLength(3);
    expect(h.url).toBe(`${ORIGIN}?world=a&seed=1`);
    expect(nav.state()?.modal).toBe('help');
    nav.closeModal('help');
    expect(h.pop()).toBe(true);
    expect(h.i).toBe(1);
    // a modal that is not on top is left alone
    nav.closeModal('help');
    expect(h.queuedBacks).toBe(0);
  });

  it('a Back of the user (not ours) is not consumed', () => {
    const { h, nav } = setup();
    nav.push('?world=a&seed=1');
    h.back();
    expect(h.pop()).toBe(false);
  });

  it('writes made while a step back is on its way wait for its popstate', () => {
    const { h, nav } = setup();
    nav.push('?room=ABCD');
    nav.home('/');
    nav.push('?world=b&seed=2');
    // nothing pushed on top of the room entry being left
    expect(h.entries).toHaveLength(2);
    expect(h.url).toBe(`${ORIGIN}?room=ABCD`);
    h.pop();
    expect(h.entries.map((e) => e.url)).toEqual([ORIGIN, `${ORIGIN}?world=b&seed=2`]);
  });

  it('closing a panel and leaving at once (help → Leave room) ends on the start page', () => {
    const { h, nav } = setup();
    nav.push('?room=ABCD');
    nav.openModal('help');
    nav.closeModal('help'); // the panel closes
    nav.home('/'); // then the room is left, before the panel's step back has landed
    h.pop(); // the panel's entry is gone; home runs now and steps back again
    expect(h.queuedBacks).toBe(1);
    h.pop();
    expect(h.i).toBe(0);
    expect(h.url).toBe(ORIGIN);
  });

  it('home does not step back over an open modal entry', () => {
    const { h, nav } = setup();
    nav.push('?room=ABCD');
    nav.openModal('settings');
    nav.home('/');
    expect(h.queuedBacks).toBe(0);
    expect(h.url).toBe(ORIGIN);
    expect(nav.state()?.modal).toBeUndefined();
  });

  it('clearModal forgets a stale modal flag', () => {
    const { nav } = setup();
    nav.openModal('rules');
    nav.clearModal();
    expect(nav.state()?.modal).toBeUndefined();
  });

  it('works without a history (sandboxed frames)', () => {
    const nav = new Nav(null, () => ORIGIN);
    nav.push('?world=a');
    nav.openModal('help');
    nav.closeModal('help');
    nav.home('/');
    expect(nav.consumePop()).toBe(false);
  });
});
