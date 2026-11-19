// The TLS-RPT identity in the reporter registry (src/dmarc/known-reporters.ts) and the carrier/tier rule applied to TLS reports (RFC 8460 sections 3 and 5.3).
// The Google report is the real one (test/fixtures/third-party/parsedmarc/google.com_smtp_tls_report.eml, Apache-2.0); only an Authentication-Results header
// naming the test's AUTHSERV_ID is added in front of it (the fixture was stripped of the receiver's own), as THIRD_PARTY.md says.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { carrierFromHeaders, decideTier } from '../../src/dmarc/reporter-auth';
import { KNOWN_REPORTERS, parseOperatorEntries, registryCandidates, reportEmailAccepted } from '../../src/dmarc/known-reporters';
import { readAuthHeaders } from '../../src/email/sender-proof';
import { extractAttachmentBytes } from '../../src/email/mime-extract';
import { extractReport } from '../../src/dmarc/extract-report';
import { checkPeriod, contactEmail, MAX_PERIOD_SECONDS } from '../../src/email/tls-rpt';

const ENV = { AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar' };
const fixture = readFileSync(resolve(__dirname, '../fixtures/third-party/parsedmarc/google.com_smtp_tls_report.eml'), 'utf8');
const stream = (text: string) => new Response(text).body!;

describe('the registry names a TLS identity for Google and Microsoft, apart from their DMARC one', () => {
  it('Google and Microsoft have one, each with evidence', () => {
    for (const id of ['google', 'microsoft']) {
      const e = KNOWN_REPORTERS.find((r) => r.id === id)!;
      expect(e.tls, id).toBeDefined();
      expect(e.tls!.evidence.length, id).toBeGreaterThan(0);
    }
    expect(KNOWN_REPORTERS.find((r) => r.id === 'google')!.tls).toMatchObject({ from: ['noreply-smtp-tls-reporting@google.com'], reportEmails: ['smtp-tls-reporting@google.com'] });
    expect(KNOWN_REPORTERS.find((r) => r.id === 'microsoft')!.tls).toMatchObject({ from: ['tlsrpt-noreply@microsoft.com'], reportEmails: ['tlsrpt-noreply@microsoft.com'] });
  });

  it('a DMARC report from the TLS From address does not match, and a TLS report from the DMARC one does not either', () => {
    expect(registryCandidates('google.com', 'noreply-smtp-tls-reporting@google.com', {}, 'dmarc')).toEqual([]);
    expect(registryCandidates('google.com', 'noreply-dmarc-support@google.com', {}, 'tls')).toEqual([]);
    expect(registryCandidates('google.com', 'noreply-smtp-tls-reporting@google.com', {}, 'tls').map((e) => e.id)).toEqual(['google']);
    expect(registryCandidates('google.com', 'noreply-dmarc-support@google.com', {}, 'dmarc').map((e) => e.id)).toEqual(['google']);
    const g = KNOWN_REPORTERS.find((r) => r.id === 'google')!;
    expect(reportEmailAccepted(g, 'smtp-tls-reporting@google.com', 'tls')).toBe(true);
    expect(reportEmailAccepted(g, 'smtp-tls-reporting@google.com', 'dmarc')).toBe(false);
    expect(reportEmailAccepted(g, 'noreply-dmarc-support@google.com', 'tls')).toBe(false);
  });

  it('an entry that sends no TLS reports (Yahoo) never matches a TLS carrier', () => {
    expect(registryCandidates('yahoo.com', 'noreply@dmarc.yahoo.com', {}, 'tls')).toEqual([]);
  });

  it('an operator may add a TLS identity (INTAKE_KNOWN_REPORTERS, two more fields); half of one is refused', () => {
    const ok = parseOperatorEntries('acme|Acme Receiver|acme-mail.com|dmarc@acme-mail.com|dmarc@acme-mail.com|tls@acme-mail.com|tls@acme-mail.com');
    expect(ok.issues).toEqual([]);
    expect(ok.entries[0].tls).toMatchObject({ from: ['tls@acme-mail.com'], reportEmails: ['tls@acme-mail.com'] });
    expect(registryCandidates('acme-mail.com', 'tls@acme-mail.com', { INTAKE_KNOWN_REPORTERS: 'acme|Acme Receiver|acme-mail.com|dmarc@acme-mail.com|dmarc@acme-mail.com|tls@acme-mail.com|tls@acme-mail.com' }, 'tls').map((e) => e.id)).toEqual(['acme']);
    expect(parseOperatorEntries('acme|Acme Receiver|acme-mail.com|dmarc@acme-mail.com|dmarc@acme-mail.com|tls@acme-mail.com').issues).toHaveLength(1);
    expect(parseOperatorEntries('acme|Acme Receiver|acme-mail.com|dmarc@acme-mail.com|dmarc@acme-mail.com').entries[0].tls).toBeUndefined();
  });
});

describe('the real Google TLS-RPT mail', () => {
  const withResults = (ar: string) => `Authentication-Results: ${ar}\r\n${fixture}`;
  const tier = async (ar: string) => {
    const headers = await readAuthHeaders(stream(withResults(ar)));
    const carrier = carrierFromHeaders(headers, ENV, 'tls');
    const report = JSON.parse(extractReport(await extractAttachmentBytes(stream(fixture)), {}));
    return { carrier, headers, decision: decideTier(carrier, { email: contactEmail(report['contact-info']), submitters: headers.submitters }) };
  };

  it('its identity: From, DKIM organisation, Submitter and contact-info are the registry\'s Google, and it counts', async () => {
    const { carrier, headers, decision } = await tier('mx.cloudflare.net; dkim=pass header.d=google.com header.s=20230601');
    expect(headers.submitters).toEqual(['google.com']);
    expect(carrier).toMatchObject({ kind: 'tls', authenticated: true, via: 'dkim', dkimOrg: 'google.com', from: 'noreply-smtp-tls-reporting@google.com' });
    expect(decision).toMatchObject({ tier: 'counted', identity: 'google', knownAs: 'Google', emailMatched: true });
  });

  it('without the receiver\'s DKIM pass it is unauthenticated, as it is after a signature by someone else', async () => {
    expect((await tier('mx.cloudflare.net; dkim=none')).decision).toMatchObject({ tier: 'unauthenticated' });
    expect((await tier('mx.cloudflare.net; dkim=pass header.d=other.example')).decision).toMatchObject({ tier: 'unauthenticated' });
    expect((await tier('mx.cloudflare.net; dmarc=pass header.from=google.com')).decision).toMatchObject({ tier: 'unauthenticated' });
  });

  it('nothing is believed from a server that is not ours', async () => {
    expect((await tier('mx.attacker.example; dkim=pass header.d=google.com')).decision).toMatchObject({ tier: 'unauthenticated', reason: 'authserv_id_not_found' });
  });
});

describe('checkPeriod (RFC 8460 section 4.1: a full day, delivered hours later, retried up to 24 hours)', () => {
  const NOW = 1_800_000_000;
  const range = (start: number, end: number) => ({ 'start-datetime': new Date(start * 1000).toISOString(), 'end-datetime': new Date(end * 1000).toISOString() });
  it('accepts a full day that ended hours ago, and up to an hour of clock skew into the future', () => {
    expect(checkPeriod(range(NOW - 30 * 3600, NOW - 6 * 3600), NOW)).toMatchObject({ ok: true });
    expect(checkPeriod(range(NOW - 23 * 3600, NOW + 3000), NOW)).toMatchObject({ ok: true });
  });
  it('refuses everything else', () => {
    const refused = (r: ReturnType<typeof range> | undefined) => checkPeriod(r, NOW).ok;
    expect(refused(range(NOW - 20 * 3600, NOW + 3 * 3600))).toBe(false); // ends in the future
    expect(refused(range(NOW - 16 * 86400, NOW - 15 * 86400))).toBe(false); // too old
    expect(refused(range(NOW - MAX_PERIOD_SECONDS - 2 * 3600, NOW - 3600))).toBe(false); // longer than 25 h
    expect(refused(range(NOW - 3600, NOW - 3600))).toBe(false); // empty
    expect(refused(range(NOW - 3600, NOW - 7200))).toBe(false); // backwards
    expect(refused(undefined)).toBe(false);
    expect(checkPeriod({ 'start-datetime': 'x', 'end-datetime': new Date(NOW * 1000).toISOString() }, NOW).ok).toBe(false);
    expect(checkPeriod({ 'start-datetime': 5 as never, 'end-datetime': 6 as never }, NOW).ok).toBe(false);
  });
});
