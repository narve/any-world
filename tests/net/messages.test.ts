/**
 * MP2 C2: what a refused or closed room connection tells the player (src/net/messages.ts noticeFor):
 * an outdated page gets net.outdated with a reload button, a deploy that closed the room gets
 * net.serverUpdated; every key is in the English and Norwegian catalogs.
 */
import { describe, it, expect } from 'vitest';
import { NET_NOTICE_KEYS, noticeFor } from '../../src/net/messages';
import { ClosedReason, RefusedCode } from '../../src/net/protocol';
import en from '../../src/client/i18n/en';
import nb from '../../src/client/i18n/nb';

describe('noticeFor', () => {
  it('an outdated page: net.outdated with reload', () => {
    expect(noticeFor({ t: 'refused', code: 'outdated', reload: true })).toEqual({ key: 'net.outdated', reload: true });
    // the reload follows from the code, not only from the flag
    expect(noticeFor({ t: 'refused', code: 'outdated' })).toEqual({ key: 'net.outdated', reload: true });
  });

  it('a deploy closed the room: net.serverUpdated, no reload', () => {
    expect(noticeFor({ t: 'closed', reason: 'server_updated' })).toEqual({ key: 'net.serverUpdated', reload: false });
    expect(noticeFor({ t: 'refused', code: 'room_closed', reason: 'server_updated' })).toEqual({ key: 'net.serverUpdated', reload: false });
    expect(noticeFor({ t: 'refused', code: 'room_closed' })).toEqual({ key: 'net.roomClosed', reload: false });
  });

  it('every refusal and close has its own key', () => {
    const keys = [...RefusedCode.options.map((code) => noticeFor({ t: 'refused', code }).key), ...ClosedReason.options.map((reason) => noticeFor({ t: 'closed', reason }).key)];
    expect(new Set(keys).size).toBe(RefusedCode.options.length + ClosedReason.options.length);
    expect([...new Set(keys)].sort()).toEqual([...NET_NOTICE_KEYS].sort());
    for (const code of RefusedCode.options) if (code !== 'outdated') expect(noticeFor({ t: 'refused', code }).reload).toBe(false);
  });

  it('en and nb have every key, and the reload button', () => {
    const catalogs: Record<string, Record<string, string>> = { en, nb };
    for (const [lang, cat] of Object.entries(catalogs)) {
      for (const key of [...NET_NOTICE_KEYS, 'net.reload']) {
        expect(cat[key], `${lang} ${key}`).toBeTruthy();
      }
    }
    expect(nb['net.outdated']).not.toBe(en['net.outdated']);
  });
});
