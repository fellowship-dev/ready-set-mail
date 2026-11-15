// How a request is counted (client and network), the budgets read from env, and the DNS text guards.
import { describe, expect, it } from 'vitest';
import { PUBLIC_REPORT_LIMITS, clientNetwork, storageBudget } from '../../src/public-reports/limits';
import { inert, inertDeep, quote, quoteValues } from '../../src/public-reports/text';

describe('clientNetwork', () => {
  it.each([
    ['198.51.100.7', 'ip4:198.51.100.7', 'ip4:198.51.100.0/24'],
    ['2001:db8:1:2::42', 'ip6:2001:db8:1:2::/64', 'ip6:2001:db8:1::/48'],
    ['2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd', 'ip6:2001:db8:1:2::/64', 'ip6:2001:db8:1::/48'],
    ['::1', 'ip6:0:0:0:0::/64', 'ip6:0:0:0::/48'],
    ['2001:db8::', 'ip6:2001:db8:0:0::/64', 'ip6:2001:db8:0::/48'],
    ['::ffff:192.0.2.9', 'ip4:192.0.2.9', 'ip4:192.0.2.0/24'],
    ['64:ff9b::192.0.2.9', 'ip6:64:ff9b:0:0::/64', 'ip6:64:ff9b:0::/48'],
  ])('%s is client %s in network %s', (ip, client, network) => {
    expect(clientNetwork(ip)).toEqual({ client, network });
  });

  it.each([null, undefined, '', 'unknown', '256.1.1.1', '1.2.3', '1:2:3:4:5:6:7:8:9', '2001:db8::1::2', 'fe80::1%eth0', 'g::1', '1:2:3:4:5:6:7::8'])('refuses %s', (ip) => {
    expect(clientNetwork(ip as string | null)).toBeNull();
  });
});

describe('storageBudget', () => {
  it('has the documented defaults: 32 KiB a report, 2,000 and 50 MiB a day, 1 GiB in all, a warning at 80%', () => {
    expect(storageBudget({})).toEqual({ dailyCap: 2000, maxReportBytes: 32_768, dailyBytes: 52_428_800, totalBytes: 1_073_741_824, warnBytes: 858_993_459 });
    expect(PUBLIC_REPORT_LIMITS).toMatchObject({ perClientPerHour: 30, perNetworkPerHour: 100, perNetworkPerDay: 200 });
  });

  it('takes positive integers from env, ignores anything else, and keeps one report within the other budgets', () => {
    expect(storageBudget({ PUBLIC_REPORTS_DAILY_CAP: '5', PUBLIC_REPORTS_MAX_REPORT_BYTES: '1000', PUBLIC_REPORTS_DAILY_BYTES: '2000', PUBLIC_REPORTS_TOTAL_BYTES: '3000' }))
      .toEqual({ dailyCap: 5, maxReportBytes: 1000, dailyBytes: 2000, totalBytes: 3000, warnBytes: 2400 });
    for (const bad of ['', '0', '-1', '1.5', 'lots', ' ']) expect(storageBudget({ PUBLIC_REPORTS_TOTAL_BYTES: bad }).totalBytes).toBe(1_073_741_824);
    expect(storageBudget({ PUBLIC_REPORTS_TOTAL_BYTES: '500' }).maxReportBytes).toBe(500);
  });
});

describe('DNS text guards', () => {
  it('makes every control, bidi and invisible character visible', () => {
    expect(inert('a\u202Eb\u2066c\u200Bd\u0000e\u009Ff\uFEFFg\u061Ch\u2028i')).toBe('a[U+202E]b[U+2066]c[U+200B]d[U+0000]e[U+009F]f[U+FEFF]g[U+061C]h[U+2028]i');
    expect(inert('v=spf1 -all')).toBe('v=spf1 -all');
    expect(inertDeep({ a: ['x\u202Ey', 1, null], b: { c: '\u0007' } })).toEqual({ a: ['x[U+202E]y', 1, null], b: { c: '[U+0007]' } });
  });

  it('quotes at most 64 characters, drops unsafe ones, and cuts with an ellipsis', () => {
    expect(quote('short')).toBe('short');
    expect(quote('\u202Eab')).toBe('ab');
    const long = quote('é'.repeat(100));
    expect(Array.from(long)).toHaveLength(64);
    expect(long.endsWith('…')).toBe(true);
    expect(quoteValues(`Invalid p= value "${'z'.repeat(100)}"`)).toBe(`Invalid p= value "${'z'.repeat(63)}…"`);
    expect(quoteValues('Missing required p= tag')).toBe('Missing required p= tag');
  });
});
