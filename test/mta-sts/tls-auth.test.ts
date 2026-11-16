// R2 item 1: a TLS report counts as evidence only when the mail was authenticated AND comes from a known reporter, by the ONE rule DMARC reports use
// (carrierFromHeaders + guardEnvelope + decideTier, src/dmarc/reporter-auth.ts). RFC 8460 section 3: reports lacking a valid DKIM signature by the reporting
// domain "MUST be ignored by the recipient"; section 5.3: TLS-Report-Submitter must match the domain of contact-info.
// The enforce gate always asks for `counted`, whatever REPORT_COUNTING says: it decides whether mail gets refused, and a stranger must never move it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { handleHostedEmail } from '../../src/hosted/intake';
import { tlsReportAddress } from '../../src/hosted/fixed-address';
import { fakeMessage, tlsRptMime } from '../helpers/mail';
import { INTAKE, mtaWorld, quietLogs, OP, type MtaWorld } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));

const TO = tlsReportAddress(INTAKE);
const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
beforeEach(() => { quietLogs(); resetSchemaReadyCache(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const AR = (org: string) => `mx.cloudflare.net; dkim=pass header.d=${org} header.s=s1`;

/** The two reporters the registry knows for TLS reports (RFC 8460 identities as they appear in public fixtures of real report mail). */
const GOOGLE = { from: 'noreply-smtp-tls-reporting@google.com', contact: 'smtp-tls-reporting@google.com', org: 'Google Inc.', domain: 'google.com' };
const MICROSOFT = { from: 'tlsrpt-noreply@microsoft.com', contact: 'tlsrpt-noreply@microsoft.com', org: 'Microsoft Corporation', domain: 'microsoft.com' };
const STRANGER = { from: 'noreply@stranger.example', contact: 'noreply@stranger.example', org: 'Google Inc.', domain: 'stranger.example' };
type Reporter = typeof GOOGLE;

let seq = 0;
interface Spec { domain?: string; start?: number | string; end?: number | string; id?: string | null; ok?: number; bad?: number; types?: string[]; contact?: string }
/** A one-day report that ended `endedAgo` seconds ago unless told otherwise. */
function body(r: Reporter, s: Spec = {}) {
  const end = s.end ?? now() - 3600;
  const start = s.start ?? (typeof end === 'number' ? end - DAY + 1 : end);
  const t = (v: number | string) => (typeof v === 'number' ? iso(v) : v);
  const details = (s.types ?? []).map((type) => ({ 'result-type': type, 'failed-session-count': s.bad ?? 1 }));
  return JSON.stringify({
    'organization-name': r.org,
    'date-range': { 'start-datetime': t(start), 'end-datetime': t(end) },
    'contact-info': s.contact ?? r.contact,
    ...(s.id === null ? {} : { 'report-id': s.id ?? `r-${++seq}` }),
    policies: [{
      policy: { 'policy-type': 'sts', 'policy-domain': s.domain ?? 'a-corp.com', 'policy-string': ['version: STSv1', 'mode: testing', 'mx: mx.a-corp.com', 'max_age: 86400'] },
      summary: { 'total-successful-session-count': s.ok ?? 20, 'total-failure-session-count': s.bad ?? 0 },
      ...(details.length ? { 'failure-details': details } : {}),
    }],
  });
}
interface Mail { from?: string; ar?: string | null; submitter?: string | null }
async function send(w: MtaWorld, r: Reporter, json: string, m: Mail = {}) {
  const headers: Record<string, string> = {};
  const ar = m.ar === undefined ? AR(r.domain) : m.ar;
  if (ar) headers['authentication-results'] = ar;
  const submitter = m.submitter === undefined ? r.domain : m.submitter;
  if (submitter) headers['TLS-Report-Submitter'] = submitter;
  const from = m.from ?? r.from;
  const msg = fakeMessage(TO, tlsRptMime(json, true, from), { from, headers });
  await handleHostedEmail(msg, w.env as any);
  return msg;
}
const stored = (w: MtaWorld) => w.rows('SELECT org_name, reporter_tier, reporter_identity, report_id, sts_success, sts_failure FROM tls_reports ORDER BY id');

/** Domain 1 enabled, setup finished, 10 days in testing, the policy id published 10 days ago. */
async function armed(w: MtaWorld) {
  await w.mta(w.A.token, 'POST', 1);
  w.cf.cname['mta-sts.a-corp.com'] = OP.target;
  w.cf.doh['_smtp._tls.a-corp.com'] = [`v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}`];
  w.cf.activateHostname('mta-sts.a-corp.com');
  await w.mta(w.A.token, 'POST', 1, undefined, '/verify');
  w.db.sqlite.prepare("UPDATE mta_sts_config SET state = 'active', mode_changed_at = ?, policy_published_at = ? WHERE domain_id = 1").run(now() - 10 * DAY, now() - 10 * DAY);
}
const gate = async (w: MtaWorld) => (await w.json(await w.mta(w.A.token, 'GET', 1))).enforce;

describe('a TLS report is authenticated before it can count (RFC 8460 section 3)', () => {
  it('an unsigned report (no authentication results at all) is stored as unauthenticated and never unlocks enforce', async () => {
    const w = await mtaWorld();
    await armed(w);
    const m = await send(w, GOOGLE, body(GOOGLE), { ar: null });
    expect(m.setReject).not.toHaveBeenCalled();
    expect(stored(w)).toMatchObject([{ reporter_tier: 'unauthenticated', reporter_identity: '~unauth' }]);
    const g = await gate(w);
    expect(g.allowed).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/No verified TLS report/);
  });

  it('dkim=none is the same as unsigned', async () => {
    const w = await mtaWorld();
    await armed(w);
    await send(w, GOOGLE, body(GOOGLE), { ar: 'mx.cloudflare.net; dkim=none' });
    expect(stored(w)).toMatchObject([{ reporter_tier: 'unauthenticated' }]);
    expect((await gate(w)).allowed).toBe(false);
  });

  it('a signature by ANOTHER organisation on mail that says it is from google.com does not authenticate it', async () => {
    const w = await mtaWorld();
    await armed(w);
    await send(w, GOOGLE, body(GOOGLE), { ar: AR('attacker.example') });
    expect(stored(w)).toMatchObject([{ reporter_tier: 'unauthenticated' }]);
    expect((await gate(w)).allowed).toBe(false);
  });

  it('a DMARC pass alone (it can rest on SPF) is not the DKIM signature the RFC asks for', async () => {
    const w = await mtaWorld();
    await armed(w);
    await send(w, GOOGLE, body(GOOGLE), { ar: 'mx.cloudflare.net; dmarc=pass header.from=google.com' });
    expect(stored(w)).toMatchObject([{ reporter_tier: 'unauthenticated' }]);
    expect((await gate(w)).allowed).toBe(false);
  });

  it('a DKIM pass by a domain that is not in the registry (stranger.example) is stored as unknown, never counted', async () => {
    const w = await mtaWorld();
    await armed(w);
    await send(w, STRANGER, body(STRANGER));
    expect(stored(w)).toMatchObject([{ reporter_tier: 'unknown', reporter_identity: 'stranger.example' }]);
    expect((await gate(w)).allowed).toBe(false);
  });

  it('a DMARC aggregate report address of Google is not Google\'s TLS identity: the From address must be the TLS one', async () => {
    const w = await mtaWorld();
    await armed(w);
    await send(w, GOOGLE, body(GOOGLE), { from: 'noreply-dmarc-support@google.com' });
    expect(stored(w)).toMatchObject([{ reporter_tier: 'unknown' }]);
    expect((await gate(w)).allowed).toBe(false);
  });

  it('TLS-Report-Submitter and the contact-info domain must be the authenticated organisation (RFC 8460 section 5.3)', async () => {
    const w = await mtaWorld();
    await armed(w);
    await send(w, GOOGLE, body(GOOGLE), { submitter: 'evil.example' });
    await send(w, GOOGLE, body(GOOGLE, { contact: 'tls@evil.example' }));
    expect(stored(w).map((r) => r.reporter_tier)).toEqual(['unknown', 'unknown']);
    expect((await gate(w)).allowed).toBe(false);
  });

  it('a genuine Google report is counted, under the identity "google", and unlocks enforce', async () => {
    const w = await mtaWorld();
    await armed(w);
    await send(w, GOOGLE, body(GOOGLE));
    expect(stored(w)).toMatchObject([{ reporter_tier: 'counted', reporter_identity: 'google', sts_success: 20 }]);
    expect(await gate(w)).toMatchObject({ allowed: true, reasons: [] });
  });

  it('the page can say the evidence rule, and that a domain that receives no TLS reports can never switch to enforce', async () => {
    const w = await mtaWorld();
    await armed(w);
    const view = await w.json(await w.mta(w.A.token, 'GET', 1));
    expect(view.evidence).toEqual({
      rule: 'Enforce needs one TLS report signed by a known sender (Google or Microsoft) about the current policy, with successful sessions and no failure that would block mail in the last 14 days.',
      no_reports_note: 'A domain that receives no TLS reports can never switch to enforce.', counted_reports: 0, uncounted_reports: 0, verifiable: true,
    });
  });

  it('a counted Microsoft report with a blocking failure blocks it', async () => {
    const w = await mtaWorld();
    await armed(w);
    await send(w, GOOGLE, body(GOOGLE));
    await send(w, MICROSOFT, body(MICROSOFT, { ok: 5, bad: 3, types: ['certificate-host-mismatch'] }));
    const g = await gate(w);
    expect(g.allowed).toBe(false);
    expect(g.reasons.join(' ')).toContain('certificate-host-mismatch');
  });
});

describe('a flood of strangers cannot move the enforce gate', () => {
  it('50 uncounted failing reports (certificate-host-mismatch) do not block a counted Google report', async () => {
    const w = await mtaWorld();
    await armed(w);
    await send(w, GOOGLE, body(GOOGLE));
    for (let i = 0; i < 50; i++) await send(w, STRANGER, body(STRANGER, { id: `flood-${i}`, end: now() - 3600 - i * 60, ok: 0, bad: 9, types: ['certificate-host-mismatch'] }));
    for (let i = 0; i < 50; i++) await send(w, GOOGLE, body(GOOGLE, { id: `unsigned-${i}`, end: now() - 7200 - i * 60, ok: 0, bad: 9, types: ['certificate-host-mismatch'] }), { ar: null });
    expect(stored(w).filter((r) => r.reporter_tier === 'counted')).toHaveLength(1);
    expect(await gate(w)).toMatchObject({ allowed: true });
  });

  it('50 uncounted passing reports do not unlock it', async () => {
    const w = await mtaWorld();
    await armed(w);
    for (let i = 0; i < 50; i++) await send(w, STRANGER, body(STRANGER, { id: `flood-${i}`, end: now() - 3600 - i * 60, ok: 500 }));
    for (let i = 0; i < 50; i++) await send(w, GOOGLE, body(GOOGLE, { id: `unsigned-${i}`, end: now() - 7200 - i * 60, ok: 500 }), { ar: null });
    expect((await gate(w)).allowed).toBe(false);
  });

  it('even REPORT_COUNTING=all (display numbers) does not let an uncounted report into the gate', async () => {
    const w = await mtaWorld({ REPORT_COUNTING: 'all' });
    await armed(w);
    await send(w, STRANGER, body(STRANGER, { ok: 500 }));
    expect((await gate(w)).allowed).toBe(false);
  });
});

describe('the period of a report is checked before anything is stored (RFC 8460 section 4.1)', () => {
  const refused = async (spec: Spec) => {
    const w = await mtaWorld();
    await armed(w);
    const m = await send(w, GOOGLE, body(GOOGLE, spec));
    return { m, rows: stored(w) };
  };
  it('refuses an end in the future (more than an hour ahead)', async () => {
    const { m, rows } = await refused({ end: now() + 3 * 3600 });
    expect(m.setReject).toHaveBeenCalledWith('Report date range is not valid');
    expect(rows).toEqual([]);
  });
  it('accepts an end up to an hour ahead (clock skew)', async () => {
    const { m, rows } = await refused({ end: now() + 1800 });
    expect(m.setReject).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });
  it('refuses a report that ended more than 14 days ago', async () => {
    const { m, rows } = await refused({ end: now() - 15 * DAY });
    expect(m.setReject).toHaveBeenCalledWith('Report date range is not valid');
    expect(rows).toEqual([]);
  });
  it('refuses a period longer than 25 hours (one day plus an hour of clock skew)', async () => {
    const end = now() - 3600;
    const long = await refused({ start: end - 26 * 3600, end });
    expect(long.m.setReject).toHaveBeenCalledWith('Report date range is not valid');
    expect(long.rows).toEqual([]);
    const ok = await refused({ start: end - 24 * 3600, end });
    expect(ok.m.setReject).not.toHaveBeenCalled();
  });
  it('refuses dates that cannot be read: today they silently became "now"', async () => {
    for (const spec of [{ start: 'garbage' }, { end: 'garbage' }, { start: '', end: '' }]) {
      const { m, rows } = await refused(spec);
      expect(m.setReject, JSON.stringify(spec)).toHaveBeenCalledWith('Report date range is not valid');
      expect(rows).toEqual([]);
    }
  });
  it('refuses an end that is not after the start', async () => {
    const t = now() - 3600;
    const { m, rows } = await refused({ start: t, end: t });
    expect(m.setReject).toHaveBeenCalledWith('Report date range is not valid');
    expect(rows).toEqual([]);
  });
});

describe('replay: one report is one report', () => {
  it('the same report twice (same reporter, same report-id) is accepted and stored once', async () => {
    const w = await mtaWorld();
    await armed(w);
    const json = body(GOOGLE, { id: 'dup-1' });
    expect((await send(w, GOOGLE, json)).setReject).not.toHaveBeenCalled();
    const again = await send(w, GOOGLE, json.replace('"total-successful-session-count":20', '"total-successful-session-count":9000'));
    expect(again.setReject).not.toHaveBeenCalled();
    expect(stored(w)).toHaveLength(1);
    expect(stored(w)[0]).toMatchObject({ sts_success: 20 });
  });

  it('a report without a report-id is deduplicated by reporter, period and policy domain', async () => {
    const w = await mtaWorld();
    await armed(w);
    const spec = { id: null, end: now() - 3600 };
    await send(w, GOOGLE, body(GOOGLE, spec));
    await send(w, GOOGLE, body(GOOGLE, spec));
    expect(stored(w)).toHaveLength(1);
  });

  it('a stranger that copies a real reporter\'s report-id and organisation name cannot displace or block the genuine report', async () => {
    const w = await mtaWorld();
    await armed(w);
    const end = now() - 3600;
    await send(w, STRANGER, body(STRANGER, { id: 'same-id', end, ok: 0, bad: 9, types: ['starttls-not-supported'] }));
    await send(w, GOOGLE, body(GOOGLE, { id: 'same-id', end }));
    expect(stored(w).map((r) => r.reporter_tier).sort()).toEqual(['counted', 'unknown']);
    expect(await gate(w)).toMatchObject({ allowed: true });
  });
});
