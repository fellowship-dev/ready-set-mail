// TLS-RPT on the fixed hosted address tls-rpt@<INTAKE_DOMAIN>: the report names its domain, the proven-owner rule attributes it, the same order of
// work as the DMARC address.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { handleHostedEmail } from '../../src/hosted/intake';
import { PEEK_BYTES, tlsReportAddress } from '../../src/hosted/fixed-address';
import { peekTlsPolicyDomain, scanTlsPolicyDomain } from '../../src/hosted/tls-intake';
import { stsStats } from '../../src/email/tls-rpt';
import { fakeMessage, tlsRptJson, tlsRptMime } from '../helpers/mail';
import { INTAKE, mtaWorld, quietLogs, type MtaWorld } from '../mta-sts/world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));

const TO = tlsReportAddress(INTAKE);
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };
beforeEach(() => { quietLogs(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const report = (policies: object[], org = 'Google Inc.') => JSON.stringify({
  'organization-name': org, 'date-range': { 'start-datetime': '2026-11-15T00:00:00Z', 'end-datetime': '2026-11-15T23:59:59Z' }, 'report-id': 'r1', policies,
});
const sts = (domain: string, ok = 10, bad = 0, details: object[] = []) => ({
  policy: { 'policy-type': 'sts', 'policy-domain': domain, 'policy-string': ['version: STSv1', 'mode: testing', 'mx: mx.a-corp.com', 'max_age: 86400'], 'mx-host': ['mx.a-corp.com'] },
  summary: { 'total-successful-session-count': ok, 'total-failure-session-count': bad }, ...(details.length ? { 'failure-details': details } : {}),
});
async function deliver(w: MtaWorld, json: string, o: { gz?: boolean; to?: string; opts?: Parameters<typeof fakeMessage>[2] } = {}) {
  const m = fakeMessage(o.to ?? TO, tlsRptMime(json, o.gz ?? true), o.opts ?? GOOGLE);
  await handleHostedEmail(m, w.env as any);
  return m;
}
const stored = (w: MtaWorld) => w.rows('SELECT workspace_id, domain_id, org_name, total_success, total_failure, sts_success, sts_failure, sts_failure_types FROM tls_reports ORDER BY id');

describe('tls-rpt@ on the fixed address', () => {
  it('files a report for a domain whose MTA-STS is on, under the owner of that domain, with the MTA-STS sessions kept apart', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    const m = await deliver(w, report([
      sts('a-corp.com', 40, 3, [{ 'result-type': 'certificate-expired', 'failed-session-count': 2 }, { 'result-type': 'starttls-not-supported', 'failed-session-count': 1 }, { 'result-type': 'certificate-expired' }]),
      { policy: { 'policy-type': 'tlsa', 'policy-domain': 'a-corp.com' }, summary: { 'total-successful-session-count': 5, 'total-failure-session-count': 1 }, 'failure-details': [{ 'result-type': 'tlsa-invalid' }] },
    ]));
    expect(m.setReject).not.toHaveBeenCalled();
    expect(stored(w)).toEqual([{ workspace_id: w.A.ws, domain_id: 1, org_name: 'Google Inc.', total_success: 45, total_failure: 4, sts_success: 40, sts_failure: 3, sts_failure_types: '["certificate-expired","starttls-not-supported"]' }]);
  });

  it('a plain JSON body (no attachment) works too, and the same report twice is one row', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    expect((await deliver(w, report([sts('a-corp.com')]), { gz: false })).setReject).not.toHaveBeenCalled();
    await deliver(w, report([sts('a-corp.com')]), { gz: true });
    expect(stored(w)).toHaveLength(1);
  });

  it('a report about a subdomain goes to the nearest proven parent that has MTA-STS on', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    const m = await deliver(w, report([sts('mail.a-corp.com')]));
    expect(m.setReject).not.toHaveBeenCalled();
    expect(stored(w)).toMatchObject([{ domain_id: 1, workspace_id: w.A.ws }]);
  });

  it('refuses a domain without MTA-STS, another workspace\'s, an unproven one and an unknown one, and stores nothing', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1); // only a-corp.com has it on
    for (const domain of ['a-two.org', 'b-corp.org', 'nobody.example']) {
      const m = await deliver(w, report([sts(domain)]));
      expect(m.setReject, domain).toHaveBeenCalledWith('Report is for a domain whose reports are not connected to this address');
    }
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'legacy' WHERE id = 1").run();
    expect((await deliver(w, report([sts('a-corp.com')]))).setReject).toHaveBeenCalledWith('Report is for a domain whose reports are not connected to this address');
    expect(stored(w)).toEqual([]);
  });

  it('files nothing for a workspace HOSTED_CONNECT_REPORTS does not admit', async () => {
    const w = await mtaWorld({ HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'a@example.com' });
    await w.mta(w.A.token, 'POST', 1);
    w.db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, policy_id, workspace_id, mx_hosts) VALUES (3, 'p', ?, 'mx.b-corp.org')").run(w.B.ws);
    expect((await deliver(w, report([sts('b-corp.org')]))).setReject).toHaveBeenCalled();
    expect((await deliver(w, report([sts('a-corp.com')]))).setReject).not.toHaveBeenCalled();
    expect(stored(w).map((r) => r.domain_id)).toEqual([1]);
  });

  it('a report that names a second domain the owner does not own is refused whole', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    const m = await deliver(w, report([sts('a-corp.com'), sts('b-corp.org')]));
    expect(m.setReject).toHaveBeenCalledWith('Report is for a domain this address does not belong to');
    expect(stored(w)).toEqual([]);
  });

  it('refuses a report with no readable policy domain, and one whose archive is broken', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    expect((await deliver(w, report([]))).setReject).toHaveBeenCalledWith(expect.stringMatching(/domain/i));
    expect((await deliver(w, 'not json at all')).setReject).toHaveBeenCalled();
    expect(stored(w)).toEqual([]);
  });

  it('is charged like the DMARC address: mail for an unowned domain is counted against the unattributed budget', async () => {
    const w = await mtaWorld({ INTAKE_MAX_UNATTRIBUTED_PER_SENDER_PER_DAY: '1' });
    await w.mta(w.A.token, 'POST', 1);
    const first = await deliver(w, report([sts('nobody.example')]));
    expect(first.setReject).toHaveBeenCalledWith('Report is for a domain whose reports are not connected to this address');
    const second = await deliver(w, report([sts('nobody.example')]));
    expect(second.setReject).toHaveBeenCalledWith(expect.stringMatching(/Daily intake limit/));
    // an owned domain still gets through: mail for unconnected domains never costs it its place
    expect((await deliver(w, report([sts('a-corp.com')]))).setReject).not.toHaveBeenCalled();
  });

  it('the token addresses still work (a hosted-records domain\'s tls-rpt+<token>@)', async () => {
    const w = await mtaWorld();
    const m = await deliver(w, report([sts('a-corp.com')]), { to: `tls-rpt+${'a'.repeat(32)}@${INTAKE}` });
    expect(m.setReject).toHaveBeenCalledWith('Unknown intake token');
  });
});

describe('scanTlsPolicyDomain', () => {
  it('reads the first policy-domain key, whatever the layout', () => {
    expect(scanTlsPolicyDomain(report([sts('A-Corp.com')]))).toBe('a-corp.com');
    expect(scanTlsPolicyDomain('{ "policies" : [ { "policy" : { "policy-domain"  :   "x.example" } } ] }')).toBe('x.example');
    expect(scanTlsPolicyDomain('junk before {"policy-domain":"x.example"}')).toBe('x.example');
  });
  it('a string is a key only when a colon follows: the text of a policy-string cannot pass for one', () => {
    const tricky = '{"policies":[{"policy":{"policy-type":"sts","policy-string":["\\"policy-domain\\": \\"victim.example\\"","policy-domain"],"policy-domain":"real.example"}}]}';
    expect(scanTlsPolicyDomain(tricky)).toBe('real.example');
    expect(scanTlsPolicyDomain('{"a":"policy-domain","b":"victim.example"}')).toBeNull();
  });
  it('refuses what is not a plain name, and what is cut short', () => {
    for (const bad of ['{"policy-domain":"a b.example"}', '{"policy-domain":"é.example"}', '{"policy-domain":"a\\u0041.example"}', '{"policy-domain": 5}', '{"policy-domain":"unterminated', '{"policy-domain"', '', '{}', 'no braces']) {
      expect(scanTlsPolicyDomain(bad), bad).toBeNull();
    }
  });
  it('is linear: a hostile prefix of the largest size is scanned in a blink, and nothing past PEEK_BYTES is read', async () => {
    const hostile = '{' + '"x":"' + '\\"'.repeat(PEEK_BYTES / 2 - 20) + '",';
    const t0 = performance.now();
    expect(scanTlsPolicyDomain(hostile)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
    const late = JSON.stringify({ pad: 'x'.repeat(PEEK_BYTES + 10), 'policy-domain': 'late.example' });
    const mime = tlsRptMime(late, true);
    const stream = new Response(mime).body!;
    expect(await peekTlsPolicyDomain(stream)).toBeNull();
    // inflation stops at the cap: a bomb costs no more than the cap
    const bomb = tlsRptMime(JSON.stringify({ pad: '0'.repeat(50_000_000) }), true);
    const t1 = performance.now();
    expect(await peekTlsPolicyDomain(new Response(bomb).body!)).toBeNull();
    expect(performance.now() - t1).toBeLessThan(2000);
  });
});

describe('stsStats', () => {
  it('counts only sts policies and lists their distinct failure types, sorted', () => {
    expect(stsStats([
      { policy: { 'policy-type': 'sts', 'policy-domain': 'a.example' }, summary: { 'total-successful-session-count': 3, 'total-failure-session-count': 2 }, 'failure-details': [{ 'result-type': 'b' }, { 'result-type': 'a' }, { 'result-type': 'b' }] },
      { policy: { 'policy-type': 'tlsa', 'policy-domain': 'a.example' }, summary: { 'total-successful-session-count': 100, 'total-failure-session-count': 100 }, 'failure-details': [{ 'result-type': 'tlsa-invalid' }] },
      { policy: { 'policy-type': 'sts', 'policy-domain': 'a.example' }, summary: { 'total-successful-session-count': 1, 'total-failure-session-count': 0 } },
    ] as any)).toEqual({ sts_success: 4, sts_failure: 2, sts_failure_types: '["a","b"]' });
    expect(stsStats([])).toEqual({ sts_success: 0, sts_failure: 0, sts_failure_types: '[]' });
  });
});
