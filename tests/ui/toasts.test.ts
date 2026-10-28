/**
 * issues/M1-toast-pileup.md — repeated refusals stacked a dozen identical toasts over the player.
 * Identical toasts now merge (count + restarted timer) and at most three are visible.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToastStack, toastLabel } from '../../src/client/ui/toasts';

afterEach(() => vi.useRealTimers());

describe('ToastStack', () => {
  it('merges identical toasts into one entry with a count', () => {
    vi.useFakeTimers();
    const t = new ToastStack();
    for (let i = 0; i < 12; i++) t.push('you cannot move', 'warn');
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0].count).toBe(12);
    expect(toastLabel(t.entries[0])).toBe('you cannot move ×12');
  });

  it('same text with another tone is a different toast', () => {
    const t = new ToastStack();
    t.push('x', 'warn');
    t.push('x', 'info');
    expect(t.entries).toHaveLength(2);
  });

  it('caps the visible stack, dropping the oldest', () => {
    vi.useFakeTimers();
    const t = new ToastStack({ max: 3 });
    for (const s of ['a', 'b', 'c', 'd', 'e']) t.push(s);
    expect(t.entries.map((e) => e.text)).toEqual(['c', 'd', 'e']);
  });

  it('a repeat moves the toast to the newest position and restarts its timer', () => {
    vi.useFakeTimers();
    const changes: number[] = [];
    const t = new ToastStack({ showMs: 1000, fadeMs: 200, onChange: (e) => changes.push(e.length) });
    t.push('a');
    t.push('b');
    vi.advanceTimersByTime(900);
    t.push('a');
    expect(t.entries.map((e) => e.text)).toEqual(['b', 'a']);
    vi.advanceTimersByTime(200); // b (pushed at 0) starts leaving at 1000 and is gone at 1200
    expect(t.isLeaving(t.entries[0].id)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(t.entries.map((e) => e.text)).toEqual(['a']);
    expect(t.isLeaving(t.entries[0].id)).toBe(false); // a was restarted at 900
    vi.advanceTimersByTime(1000);
    expect(t.entries).toHaveLength(0);
    expect(changes.length).toBeGreaterThan(0);
  });

  it('a repeat while fading brings the toast back', () => {
    vi.useFakeTimers();
    const t = new ToastStack({ showMs: 1000, fadeMs: 500 });
    const a = t.push('a');
    vi.advanceTimersByTime(1100);
    expect(t.isLeaving(a.id)).toBe(true);
    t.push('a');
    expect(t.isLeaving(a.id)).toBe(false);
    vi.advanceTimersByTime(600);
    expect(t.entries).toHaveLength(1);
  });

  it('clear() empties the stack and cancels timers', () => {
    vi.useFakeTimers();
    const t = new ToastStack();
    t.push('a');
    t.clear();
    expect(t.entries).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a toast can carry an action; a sticky one has no timer and is exempt from the cap (MP3)', () => {
    vi.useFakeTimers();
    const t = new ToastStack({ max: 3, showMs: 1000, fadeMs: 200 });
    const run = vi.fn();
    const sticky = t.push('outdated', 'warn', { label: 'Reload', run, sticky: true });
    for (const s of ['a', 'b', 'c', 'd']) t.push(s);
    // three timed ones plus the sticky one: the sticky one was never dropped as the oldest
    expect(t.entries.map((e) => e.text)).toEqual(['outdated', 'b', 'c', 'd']);
    vi.advanceTimersByTime(5000);
    expect(t.entries.map((e) => e.text)).toEqual(['outdated']);
    expect(t.entries[0].action?.label).toBe('Reload');
    t.dismiss(sticky.id);
    expect(t.entries).toEqual([]);
    const change = t.push('You are Kari 2', 'info', { label: 'Change', run });
    expect(change.action?.sticky).toBeUndefined();
    vi.advanceTimersByTime(1300);
    expect(t.entries).toEqual([]);
  });
});
