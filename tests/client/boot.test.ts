/**
 * issues/M1-reload-wipes-run.md — reloading a `?world=` link used to clear the autosave and start
 * over. Boot routing must resume a matching run and never discard another one without asking.
 */
import { describe, it, expect } from 'vitest';
import { bootRoute, parseSeed, runUrl } from '../../src/client/boot';

const saved = { worldId: 'fixture-teen', worldTitle: 'Teen Fixture', seed: 4 };
const titles = (id: string) => (id === 'fixture-ship' ? 'Ship Fixture' : undefined);

describe('bootRoute', () => {
  it('a fresh ?world= link starts that world with its seed', () => {
    expect(bootRoute('?world=fixture-teen&seed=4', null)).toEqual({ kind: 'new', worldId: 'fixture-teen', seed: 4 });
    expect(bootRoute('?world=fixture-teen', null)).toEqual({ kind: 'new', worldId: 'fixture-teen' });
  });

  it('reloading the same ?world=&seed= link resumes the saved run', () => {
    expect(bootRoute('?world=fixture-teen&seed=4', saved)).toEqual({ kind: 'continue' });
    expect(bootRoute('?world=fixture-teen', saved)).toEqual({ kind: 'continue' });
    // saves written before the seed was stored still resume
    expect(bootRoute('?world=fixture-teen&seed=9', { worldId: 'fixture-teen', worldTitle: 'T' })).toEqual({ kind: 'continue' });
  });

  it('a link to another world or seed opens the start screen instead of discarding the run', () => {
    const other = bootRoute('?world=fixture-ship&seed=4', saved, titles);
    expect(other.kind).toBe('start');
    expect(other.kind === 'start' && other.notice).toMatch(/Teen Fixture.*Ship Fixture/);
    expect(bootRoute('?world=fixture-teen&seed=5', saved).kind).toBe('start');
  });

  it('?continue=1 and the bare page', () => {
    expect(bootRoute('?continue=1', saved)).toEqual({ kind: 'continue' });
    expect(bootRoute('?continue=1', null)).toEqual({ kind: 'start' });
    expect(bootRoute('', saved)).toEqual({ kind: 'start' });
  });

  it('?room= opens the room (MP3): upper-cased, valid codes only, over ?world=, the saved run kept', () => {
    expect(bootRoute('?room=k7qx', null)).toEqual({ kind: 'room', code: 'K7QX' });
    expect(bootRoute('?room=K7QX', saved)).toEqual({ kind: 'room', code: 'K7QX' });
    expect(bootRoute('?room=%20k7qx%20', null)).toEqual({ kind: 'room', code: 'K7QX' });
    // 0, O, 1, I and L are not in room codes; nor are other lengths
    for (const bad of ['K7Q0', 'KOQX', 'K7Q', 'K7QXX', '', 'k7-x']) expect(bootRoute(`?room=${bad}`, saved), bad).toEqual({ kind: 'start' });
    expect(bootRoute('?world=fixture-teen&room=k7qx', saved)).toEqual({ kind: 'room', code: 'K7QX' });
    expect(bootRoute('?room=k7qx&world=fixture-ship&seed=4', null)).toEqual({ kind: 'room', code: 'K7QX' });
    expect(saved).toEqual({ worldId: 'fixture-teen', worldTitle: 'Teen Fixture', seed: 4 });
  });

  it('runUrl round-trips through bootRoute', () => {
    const url = runUrl('fixture-teen', 4);
    expect(url).toBe('?world=fixture-teen&seed=4');
    expect(bootRoute(url, saved)).toEqual({ kind: 'continue' });
  });

  it('parseSeed accepts positive integers only', () => {
    expect(parseSeed('4')).toBe(4);
    expect(parseSeed(null)).toBeUndefined();
    expect(parseSeed('')).toBeUndefined();
    expect(parseSeed('0')).toBeUndefined();
    expect(parseSeed('-3')).toBeUndefined();
    expect(parseSeed('abc')).toBeUndefined();
  });
});

describe('main.ts boot never clears the run', () => {
  it('boot() routes through bootRoute and has no clearRun on its path', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/client/main.ts', import.meta.url), 'utf8');
    const boot = src.slice(src.indexOf('async function boot('));
    expect(boot).toContain('bootRoute(');
    expect(boot.slice(0, boot.indexOf('\n}\n'))).not.toContain('clearRun');
  });
});
