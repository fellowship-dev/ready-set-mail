// Read-only probe for the subdomain audit (not for the repo). Runs the live commit's Worker code under the repo's own
// node harness: in-memory D1 (migrated), fake DNS answering the owner's real public records, real intake, real API router.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gzipSync, strToU8 } from 'fflate';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { handleHostedEmail } from '../../src/hosted/intake';
import { fakeMessage, mimeWithAttachment } from '../helpers/mail';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from './world';
import { checkDmarc } from '../../src/public-reports/check';
import { checkDomain } from '@ready-set-mail/dns-checks';
import { lookupDmarc } from '../../packages/dns-checks/src/dmarc';
import { dmarcFactsFromLookup } from '../../src/email/dns-snapshot';
import { policyInForce, dmarcSteps } from '../../packages/dns-checks/src/dmarc-next-step';
import { organizationalDomain } from '../../packages/dns-checks/src/org-domain';
import { reportDomainCandidates } from '../../src/hosted/fixed-address';
import { failingMailFate, explain } from '../../web/src/lib/reports';
import { assessDomain } from '../../web/src/lib/levels';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
vi.mock('../../src/dns/provision', () => ({ provisionDomain: vi.fn().mockResolvedValue({ recordId: null, recordName: null, manual: true }) }));

const OUT: Record<string, unknown> = {};
const log = (k: string, v: unknown) => { OUT[k] = v; };
afterAll(() => { console.info('PROBE_JSON ' + JSON.stringify(OUT)); });
import { afterAll } from 'vitest';

const FIXED = 'rua@rua.readysetmail.com';
const REC = 'v=DMARC1; p=reject; rua=mailto:rua@rua.readysetmail.com;';
// The owner's public DNS on 2026-11-15 (dig @1.1.1.1 and @8.8.8.8).
const MAX_DNS: Record<string, Record<string, string[]>> = {
  '_dmarc.readysetmail.com': { TXT: [REC] },
  '_dmarc.app.readysetmail.com': { TXT: [REC] },
  'readysetmail.com': { TXT: ['v=spf1 include:_spf.protonmail.ch ~all', 'protonmail-verification=x'], MX: ['10 mail.protonmail.ch.', '20 mailsec.protonmail.ch.'], A: ['216.150.16.129'] },
  'app.readysetmail.com': { A: ['104.21.85.16'] },
  'rua.readysetmail.com': { TXT: ['v=spf1 include:_spf.mx.cloudflare.net ~all'], MX: ['5 route3.mx.cloudflare.net.'] },
  'cf-bounce.app.readysetmail.com': { TXT: ['v=spf1 include:_spf.mx.cloudflare.net ~all'], MX: ['5 route3.mx.cloudflare.net.'] },
  'cf-bounce._domainkey.app.readysetmail.com': { TXT: ['v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkq'] },
  '_spf.protonmail.ch': { TXT: ['v=spf1 ip4:185.70.40.0/24 ~all'] },
  '_spf.mx.cloudflare.net': { TXT: ['v=spf1 ip4:104.30.0.0/19 ~all'] },
};
const CODES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, PTR: 12 };
function dnsFetch(zone: Record<string, Record<string, string[]>>) {
  return async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const name = (u.searchParams.get('name') ?? '').toLowerCase().replace(/\.$/, '');
    const type = (u.searchParams.get('type') ?? 'A').toUpperCase();
    const node = zone[name];
    const exists = node || Object.keys(zone).some((k) => k.endsWith(`.${name}`));
    if (!exists) return new Response(JSON.stringify({ Status: 3 }), { status: 200 });
    const data = node?.[type] ?? [];
    return new Response(JSON.stringify({ Status: 0, Answer: data.map((d) => ({ name, type: CODES[type] ?? 16, TTL: 60, data: type === 'TXT' ? `"${d}"` : d })) }), { status: 200 });
  };
}
const resolverFor = (zone: Record<string, Record<string, string[]>>) => {
  const f = dnsFetch(zone);
  const resolve = async (name: string, type: string) => {
    const r = await (await f(`https://x/?name=${encodeURIComponent(name)}&type=${type}`)).json() as any;
    return { status: r.Status === 3 ? 'nxdomain' : (r.Answer?.length ? 'ok' : 'nodata'), answers: (r.Answer ?? []).map((a: any) => ({ ...a })) };
  };
  return {
    resolve: resolve as any,
    txt: async (name: string) => { const r = await resolve(name, 'TXT') as any; return { status: r.status, records: r.answers.map((a: any) => String(a.data).replace(/^"|"$/g, '')) }; },
    fetch: (async () => new Response('', { status: 404 })) as any,
  } as any;
};

// A report with several records: [header_from, envelope(spf) domain, dkim d=, aligned spf?, aligned dkim?, count]
type Row = [string, string, string, boolean, boolean, number];
function xml(policyDomain: string, id: string, rows: Row[], org = 'google.com', p = 'reject') {
  const recs = rows.map(([hf, spfd, dkimd, spfA, dkimA, n], i) => `<record><row><source_ip>203.0.113.${i + 1}</source_ip><count>${n}</count>
  <policy_evaluated><disposition>none</disposition><dkim>${dkimA ? 'pass' : 'fail'}</dkim><spf>${spfA ? 'pass' : 'fail'}</spf></policy_evaluated></row>
  <identifiers><header_from>${hf}</header_from></identifiers>
  <auth_results><dkim><domain>${dkimd}</domain><result>pass</result></dkim><spf><domain>${spfd}</domain><result>pass</result></spf></auth_results></record>`).join('\n');
  return `<?xml version="1.0"?><feedback><report_metadata><org_name>${org}</org_name><email>noreply-dmarc-support@${org}</email><report_id>${id}</report_id>
  <date_range><begin>${Math.floor(Date.now()/1000)-2*86400}</begin><end>${Math.floor(Date.now()/1000)-86400}</end></date_range></report_metadata>
  <policy_published><domain>${policyDomain}</domain><adkim>r</adkim><aspf>r</aspf><p>${p}</p><sp>${p}</sp><pct>100</pct></policy_published>${recs}</feedback>`;
}
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' }, from: 'noreply-dmarc-support@google.com' };
const mime = (x: string) => mimeWithAttachment(gzipSync(strToU8(x)), 'r.xml.gz', 'application/gzip');

beforeEach(() => { resetSchemaReadyCache(); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.stubGlobal('fetch', dnsFetch(MAX_DNS)); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function hostedOwner() {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV, HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'owner@example.com' }) as any;
  const token = await signupVerified(env, 'owner@example.com');
  const rows = (s: string, ...p: unknown[]) => db.sqlite.prepare(s).all(...p) as any[];
  const ws = rows("SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'owner@example.com'")[0].workspace_id;
  // readysetmail.com verified (as on the live app: through the Cloudflare zone; 'txt' here: the proof kind does not change filing) and reports connected
  db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via, reports_connected_at) VALUES (1, ?, 'readysetmail.com', ?, 'txt', 1)").run(ws, FIXED);
  const send = async (x: string) => { const m = fakeMessage(FIXED, mime(x), GOOGLE); await handleHostedEmail(m, env); return { rejected: m.setReject.mock.calls.map((c: any[]) => c[0]) }; };
  const filed = () => rows('SELECT ar.report_id, d.domain AS filed_under, ar.workspace_id = ? AS same_ws, ar.total_count, ar.pass_count, ar.reporter_tier FROM aggregate_reports ar JOIN domains d ON d.id = ar.domain_id ORDER BY ar.id', ws);
  const api = (method: string, path: string, body?: unknown) => call(env, method, path, { key: token, ...(body !== undefined ? { body } : {}) });
  return { db, env, ws, rows, send, filed, api };
}

describe('PART 1: readysetmail.com verified + connected, app.readysetmail.com not added', () => {
  it('(a) filing', async () => {
    const w = await hostedOwner();
    log('a1_app_policy_report', await w.send(xml('app.readysetmail.com', 'r-app', [['app.readysetmail.com', 'cf-bounce.app.readysetmail.com', 'app.readysetmail.com', true, true, 40]])));
    log('a2_parent_report_with_sub_rows', await w.send(xml('readysetmail.com', 'r-parent', [
      ['readysetmail.com', 'readysetmail.com', 'readysetmail.com', true, true, 10],
      ['app.readysetmail.com', 'cf-bounce.app.readysetmail.com', 'app.readysetmail.com', true, true, 5],
      ['cf-bounce.app.readysetmail.com', 'cf-bounce.app.readysetmail.com', 'app.readysetmail.com', true, true, 1],
    ])));
    log('a3_app_report_with_parent_row', await w.send(xml('app.readysetmail.com', 'r-app-mixed', [['readysetmail.com', 'readysetmail.com', 'readysetmail.com', true, true, 1]])));
    log('a4_sibling_rua_report', await w.send(xml('rua.readysetmail.com', 'r-rua', [['rua.readysetmail.com', 'rua.readysetmail.com', 'rua.readysetmail.com', false, false, 2]])));
    log('a5_unrelated', await w.send(xml('example.org', 'r-x', [['example.org', 'example.org', 'example.org', true, true, 1]])));
    log('a_filed', w.filed());
    log('a_records', w.rows('SELECT ar.report_id, rr.header_from, rr.spf_domain, rr.dkim_domain, rr.count FROM report_records rr JOIN aggregate_reports ar ON ar.id = rr.report_id ORDER BY rr.id'));
    log('a_domains', w.rows('SELECT id, domain, parent_id, verified_via, rua_address FROM domains'));

    // (b) what the dashboard API shows for the parent row
    const list = await w.api('GET', '/api/domains'); log('b_domains_list', { status: list.status, body: await list.json() });
    const st = await w.api('GET', '/api/domains/1/stats?days=90'); log('b_stats', { status: st.status, body: await st.json() });
    const src = await w.api('GET', '/api/domains/1/sources?days=90'); log('b_sources', { status: src.status, body: await src.json() });
    const an = await w.api('GET', '/api/domains/1/anomalies?days=90'); log('b_anomalies', { status: an.status, body: await an.json() });
    const ob = await w.api('GET', '/api/domains/1/onboarding-status'); const obj = await ob.json() as any; log('b_parent_onboarding', { status: ob.status, dmarc: obj.dmarc, spf: obj.spf, dkim: obj.dkim });

    // (c) add app.readysetmail.com as its own domain
    const before = w.rows('SELECT COUNT(*) n FROM domains WHERE workspace_id = ? AND evicted_at IS NULL', w.ws)[0].n;
    const add = await w.api('POST', '/api/domains', { domain: 'app.readysetmail.com' }); const addBody = await add.json();
    log('c_add', { status: add.status, body: addBody, countBefore: before, countAfter: w.rows('SELECT COUNT(*) n FROM domains WHERE workspace_id = ? AND evicted_at IS NULL', w.ws)[0].n });
    log('c_domains_after_add', w.rows('SELECT id, domain, parent_id, verified_via, rua_address, reports_connected_at FROM domains'));
    log('c_app_report_after_add', await w.send(xml('app.readysetmail.com', 'r-app-2', [['app.readysetmail.com', 'cf-bounce.app.readysetmail.com', 'app.readysetmail.com', true, true, 7]])));
    log('c_parent_report_after_add', await w.send(xml('readysetmail.com', 'r-parent-2', [['app.readysetmail.com', 'cf-bounce.app.readysetmail.com', 'app.readysetmail.com', true, true, 3]])));
    log('c_filed_after_add', w.filed());
    const subId = w.rows("SELECT id FROM domains WHERE domain = 'app.readysetmail.com'")[0]?.id;
    if (subId) {
      const sob = await w.api('GET', `/api/domains/${subId}/onboarding-status`); const s = await sob.json() as any;
      log('d_sub_onboarding', { status: sob.status, dmarc: s.dmarc, spf: s.spf, dkim: s.dkim, nxdomain: s.nxdomain });
      const sst = await w.api('GET', `/api/domains/${subId}/stats?days=90`); log('c_sub_stats', await sst.json());
      const pdet = await w.api('GET', `/api/domains/${subId}`); log('d_sub_detail', { status: pdet.status, body: await pdet.json() });
    }
    const pdet1 = await w.api('GET', '/api/domains/1'); log('d_parent_detail', { status: pdet1.status, body: await pdet1.json() });
    // fill to the hosted limit with subdomains
    for (let i = 0; i < 12; i++) { const r = await w.api('POST', '/api/domains', { domain: `s${i}.readysetmail.com` }); if (r.status !== 201 && r.status !== 200) { log('c_limit_hit', { at: i, status: r.status, body: await r.json(), live: w.rows('SELECT COUNT(*) n FROM domains WHERE workspace_id = ? AND evicted_at IS NULL', w.ws)[0].n }); break; } }
    expect(true).toBe(true);
  });

  it('(d) public checker and agent report for the subdomain, with the real records', async () => {
    const r = resolverFor(MAX_DNS);
    log('d_public_checkDmarc_app', await checkDmarc('app.readysetmail.com', r));
    const rep = await checkDomain('app.readysetmail.com', { fetch: dnsFetch(MAX_DNS) as any } as any).catch((e) => ({ error: String(e) }));
    log('d_agent_report_app', { grade: (rep as any).grade, dmarc: (rep as any).dmarc?.status, inherited: (rep as any).dmarc?.inherited, spf: (rep as any).spf?.status, dkim: (rep as any).dkim?.found ?? (rep as any).dkim });
    const repc = await checkDomain('cf-bounce.app.readysetmail.com', { fetch: dnsFetch(MAX_DNS) as any } as any).catch((e) => ({ error: String(e) }));
    log('d_agent_report_cfbounce', { grade: (repc as any).grade, inherited: (repc as any).dmarc?.inherited });
    expect(true).toBe(true);
  });
});

// PART 2 matrix: each zone is the parent's record (+ optional sub record); the product functions are called on the subdomain.
const P = (rec: string, sub?: string, extra: Record<string, Record<string, string[]>> = {}) => ({
  '_dmarc.example.com': { TXT: [rec] }, 'example.com': { TXT: ['v=spf1 -all'] }, 'mail.example.com': { A: ['192.0.2.1'], TXT: ['v=spf1 include:_spf.example.net -all'] },
  ...(sub ? { '_dmarc.mail.example.com': { TXT: [sub] } } : {}), ...extra,
});
const CASES: Array<[string, string, Record<string, Record<string, string[]>>]> = [
  ['M1 parent p=reject, no sp, sub no record', 'mail.example.com', P('v=DMARC1; p=reject; rua=mailto:r@example.com')],
  ['M2 parent p=reject sp=none', 'mail.example.com', P('v=DMARC1; p=reject; sp=none; rua=mailto:r@example.com')],
  ['M3 parent p=reject sp=quarantine', 'mail.example.com', P('v=DMARC1; p=reject; sp=quarantine; rua=mailto:r@example.com')],
  ['M4 parent p=reject sp=rejectt (invalid)', 'mail.example.com', P('v=DMARC1; p=reject; sp=rejectt; rua=mailto:r@example.com')],
  ['M5 parent p=reject np=none, non-existent sub', 'ghost.example.com', P('v=DMARC1; p=reject; np=none; rua=mailto:r@example.com')],
  ['M5b parent p=none np=reject, non-existent sub', 'ghost.example.com', P('v=DMARC1; p=none; np=reject; rua=mailto:r@example.com')],
  ['M6 sub own p=none under parent p=reject', 'mail.example.com', P('v=DMARC1; p=reject; rua=mailto:r@example.com', 'v=DMARC1; p=none; rua=mailto:r@example.com')],
  ['M7 sub own p=reject under parent p=none', 'mail.example.com', P('v=DMARC1; p=none; rua=mailto:r@example.com', 'v=DMARC1; p=reject; rua=mailto:r@example.com')],
  ['M8 deep a.b.c.example.co.uk, record at example.co.uk', 'a.b.c.example.co.uk', { '_dmarc.example.co.uk': { TXT: ['v=DMARC1; p=reject; sp=none'] }, 'a.b.c.example.co.uk': { A: ['192.0.2.1'] } }],
  ['M9 deep a.b.c.example.com, record only at b.c.example.com (tree walk finds it, PSL does not)', 'a.b.c.example.com', { '_dmarc.b.c.example.com': { TXT: ['v=DMARC1; p=reject'] }, '_dmarc.example.com': { TXT: ['v=DMARC1; p=none'] }, 'a.b.c.example.com': { A: ['192.0.2.1'] } }],
  ['M10 private suffix foo.pages.dev with record at pages.dev', 'foo.pages.dev', { '_dmarc.pages.dev': { TXT: ['v=DMARC1; p=reject'] }, 'foo.pages.dev': { A: ['192.0.2.1'] } }],
  ['M11 wildcard TXT answers _dmarc.<anything>', 'mail.example.com', P('v=DMARC1; p=reject', 'v=spf1 -all')],
  ['M12 parked sub (spf -all, no dmarc)', 'parked.example.com', { '_dmarc.example.com': { TXT: ['v=DMARC1; p=reject'] }, 'parked.example.com': { TXT: ['v=spf1 -all'], MX: ['0 .'] } }],
  ['M13 strict alignment on parent', 'mail.example.com', P('v=DMARC1; p=reject; adkim=s; aspf=s; rua=mailto:r@example.com')],
];

describe('PART 2 matrix', () => {
  it('runs every case through every judge', async () => {
    const out: Record<string, unknown> = {};
    for (const [label, name, zone] of CASES) {
      const r = resolverFor(zone);
      const look = await lookupDmarc(r, name);
      const facts = dmarcFactsFromLookup(look);
      const stored = facts ? { dmarc_policy: facts.policy, dmarc_issue: facts.issue, dmarc_inherited_from: facts.inherited_from, dmarc_pct: facts.pct, dmarc_p: facts.p, dmarc_sp: facts.sp, dmarc_rua: 1 } : {};
      const inForce = policyInForce(name, stored as any);
      let steps: unknown;
      try { steps = dmarcSteps(name, inForce, { reportsAddress: true, ruaAddress: 'rua@rua.readysetmail.com', reports: { total: 1000, passed: 990 } } as any).map((s: any) => ({ key: s.key, status: s.status, do: s.do, at: s.at, record: s.record, recordAt: s.recordAt })); } catch (e) { steps = String(e); }
      const pub = await checkDmarc(name, r);
      const agent = await checkDomain(name, { fetch: dnsFetch(zone) as any } as any).catch((e) => ({ error: String(e) }));
      const lvl = (() => { try { return assessDomain({ ...(stored as any), spf_record: 'v=spf1 -all', spf_lookup_count: 0, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, dns_checked_at: 1, domain: name } as any); } catch (e) { return String(e); } })();
      out[label] = {
        org: organizationalDomain(name), candidates: reportDomainCandidates(name),
        lookup: { status: look.status, foundAt: look.foundAt, inherited: look.inherited, p: look.record?.policy, sp: look.record?.subdomainPolicy, valid: look.record?.valid },
        facts, inForce, steps,
        public: { grade: (pub as any).grade, findings: (pub as any).findings?.map((f: any) => `${f.status}:${f.id ?? f.code}: ${f.message ?? f.text ?? ''}`) },
        agent: { level: (agent as any).grade?.level, label: (agent as any).grade?.label, reasons: (agent as any).grade?.reasons },
        dashboardLevel: typeof lvl === 'string' ? lvl : { level: (lvl as any).level, findings: (lvl as any).findings?.map((f: any) => `${f.status}: ${f.label}`) },
      };
    }
    log('matrix', out);
    // failingMailFate / explain for a subdomain row under the parent's page
    log('fate_sub_has_own_record', failingMailFate('reject', { domain: 'readysetmail.com', sp: null, invalidSp: null, pct: 100 } as any, 'app.readysetmail.com'));
    log('fate_parent_reject_sub_own_none', failingMailFate('reject', { domain: 'example.com', sp: null, invalidSp: null, pct: 100 } as any, 'mail.example.com'));
    log('explain_spf_unaligned_bounce', explain({ source_ip: '1', header_from: 'app.readysetmail.com', spf_domain: 'cf-bounce.app.readysetmail.com', dkim_domain: 'app.readysetmail.com', spf_pass: 0, dkim_pass: 1, base_domain: null, org: null } as any, 'reject'));
    log('explain_esp_unaligned_both_pass_raw', { isShownFailing: false, note: 'anomalySources filters on raw auth_results; aligned=fail rows with raw pass never appear' });
    expect(true).toBe(true);
  });

  it('anomalies hide DMARC failures whose raw SPF and DKIM pass (unaligned ESP)', async () => {
    const w = await hostedOwner();
    await w.send(xml('readysetmail.com', 'r-esp', [['readysetmail.com', 'bounces.esp.example', 'esp.example', false, false, 9]]));
    const an = await w.api('GET', '/api/domains/1/anomalies?days=3650'); const st = await w.api('GET', '/api/domains/1/stats?days=3650');
    log('bug_unaligned_hidden', { filed: w.filed(), anomalies: await an.json(), stats: await st.json() });
    expect(true).toBe(true);
  });
});
