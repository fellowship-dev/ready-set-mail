// B11 (audit): "last two labels" took the registrable domain of `mx.mail.example.co.uk` to be `co.uk`, grouping unrelated senders under a public
// suffix. Every site now asks the one registrable-domain function (packages/dns-checks/src/org-domain.ts, the Public Suffix List).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getIpInfo } from '../../src/dmarc/ip-info';
import { parseAggregateReportXml } from '../../src/dmarc/parse-aggregate';
import { reportXml } from './world';

afterEach(() => vi.unstubAllGlobals());

const ptrFetch = (ptr: string) => vi.fn(async (url: string | URL | Request) => {
  const u = new URL(String(url));
  const answer = u.searchParams.get('type') === 'PTR' ? [{ name: 'x', type: 12, TTL: 60, data: `${ptr}.` }] : [];
  return new Response(JSON.stringify({ Status: 0, Answer: answer }), { status: 200 });
});

describe('B11: the PTR base domain of a sender', () => {
  it.each([
    ['mx.mail.example.co.uk', 'example.co.uk'],
    ['smtp.example.com.au', 'example.com.au'],
    ['mail-out.example.com', 'example.com'],
    ['example.com', 'example.com'],
  ])('%s groups under %s, never under the public suffix', async (ptr, base) => {
    vi.stubGlobal('fetch', ptrFetch(ptr));
    expect((await getIpInfo('203.0.113.7')).base_domain).toBe(base);
  });
});

describe('B11: the reporter organisation name in a report', () => {
  it('keeps the registrable domain of a co.uk reporter, and still strips a subdomain of .com', async () => {
    const co = await parseAggregateReportXml(reportXml('example.com', 'r1', [{ from: 'example.com', spf: 'example.com', dkim: 'example.com', spfAligned: true, dkimAligned: true, n: 1 }], { org: 'dmarc.mail.example.co.uk' }), true);
    expect(co.report_metadata.org_name).toBe('example.co.uk');
    const com = await parseAggregateReportXml(reportXml('example.com', 'r2', [{ from: 'example.com', spf: 'example.com', dkim: 'example.com', spfAligned: true, dkimAligned: true, n: 1 }], { org: 'noreply.mail.google.com' }), true);
    expect(com.report_metadata.org_name).toBe('google.com');
  });
});
