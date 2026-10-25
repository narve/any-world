/**
 * M5 shell fixes (issues/M5-offline-demo-labelled-ai.md): a world the offline demo generator picked from
 * the recorded worlds is listed as a recorded demo, never as "made by AI".
 */
import { describe, it, expect, afterAll } from 'vitest';
import { recentSource } from '../../src/client/storage';
import { recentSourceLabel } from '../../src/client/ui/components/screens';
import { catalog, getLanguage, setLanguage } from '../../src/client/i18n/index';

describe('recentSource', () => {
  it('a kept copy of a recorded world (offline demo generator, has origin) is a demo', () => {
    expect(recentSource({ source: 'generated', origin: 'nb-troll-direktoratet' })).toBe('demo');
  });
  it('AI-made worlds (with or without the M4 source field) stay "generated"', () => {
    expect(recentSource({ source: 'generated' })).toBe('generated');
    expect(recentSource({})).toBe('generated');
  });
  it('imported worlds stay imported, even if the file was once a demo copy', () => {
    expect(recentSource({ source: 'imported' })).toBe('imported');
    expect(recentSource({ source: 'imported', origin: 'fixture-teen' })).toBe('imported');
  });
});

describe('recentSourceLabel', () => {
  const before = getLanguage();
  afterAll(() => setLanguage(before, { persist: false }));

  it('both catalogs have the demo label and it does not claim AI', () => {
    expect(catalog('en')?.['start.recentDemo']).toBeTruthy();
    expect(catalog('nb')?.['start.recentDemo']).toBeTruthy();
    expect(catalog('en')!['start.recentDemo']).not.toMatch(/\bAI\b/i);
    expect(catalog('nb')!['start.recentDemo']).not.toMatch(/\bKI\b/i);
  });

  it('labels each source with its own catalog line (Norwegian)', () => {
    setLanguage('nb', { persist: false });
    expect(recentSourceLabel('demo')).toBe('innspilt demo');
    expect(recentSourceLabel('generated')).toBe('laget av KI');
    expect(recentSourceLabel('imported')).toBe('fra fil');
  });

  it('labels each source with its own catalog line (English)', () => {
    setLanguage('en', { persist: false });
    expect(recentSourceLabel('demo')).toBe('recorded demo');
    expect(recentSourceLabel('generated')).toBe('made by AI');
    expect(recentSourceLabel('imported')).toBe('from a file');
  });
});
