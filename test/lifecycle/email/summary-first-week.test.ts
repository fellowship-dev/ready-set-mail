// The weekly summary never covers a week that ended before it shipped (SUMMARY_FIRST_WEEK): the catch-up of a missed Monday must not summarise
// 2026-W46 on Friday 20 Nov in the same run as the first-report catch-up, which already told the owner about that report.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY, lifecycleWorld, recordNamingUs } from './world';

const D = 'brightwave-mail.com';
const utc = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h, m) / 1000;
const google = { ip: '192.0.2.10', count: 40, spf: ['pass', D] as [string, string], dkim: ['pass', D] as [string, string], org: 'Google Workspace' };

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the first weekly summary is 2026-W47', () => {
  it('Fri 20 Nov: only the first-report catch-up (no W46 summary); Mon 23 Nov: the W47 summary, once', async () => {
    const w = await lifecycleWorld();
    w.catchUp();
    w.realSummaryStart();
    const setNow = (t: number) => { w.clock.now = t; vi.setSystemTime(t * 1000); };
    setNow(utc(16, 10, 52));
    w.addDomain({ domain: D, createdAt: utc(14, 10), connectedAt: utc(14, 10) });
    w.addReport({ domain: D, day: utc(15, 0), storedAt: utc(16, 10, 52), records: [google] });
    for (const d of [16, 17, 18, 19]) w.addReport({ domain: D, day: utc(d, 0), storedAt: utc(d + 1, 3), records: [google] });
    w.dns.set(D, recordNamingUs());
    setNow(utc(20, 11));
    await w.run();
    expect(w.sent().map((m) => m.subject)).toEqual([`First DMARC report for ${D}: 40 messages, all passed`]);
    setNow(utc(23, 11));
    await w.run();
    const weeks = w.sent().map((m) => m.subject).filter((s) => s.startsWith('Week of'));
    expect(weeks).toHaveLength(1);
    expect(weeks[0]).toMatch(/^Week of 16–22 Nov: /);
    setNow(utc(24, 11));
    await w.run();
    expect(w.sent().filter((m) => m.subject.startsWith('Week of'))).toHaveLength(1);
  });
});
