// The owner's world for the subdomain tests (fixtures lifted from the audit's probe): a hosted workspace that proved readysetmail.com and
// connected reports, fake public DNS answering the owner's real records, the real report intake and the real API router.
import { gzipSync, strToU8 } from 'fflate';
import { vi } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { handleHostedEmail } from '../../src/hosted/intake';
import { fakeMessage, mimeWithAttachment } from '../helpers/mail';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';

export const FIXED = 'rua@rua.readysetmail.com';
export const REC = 'v=DMARC1; p=reject; rua=mailto:rua@rua.readysetmail.com;';

export type Zone = Record<string, Record<string, string[]>>;

/** The owner's public DNS on 2026-11-15 (dig @1.1.1.1 and @8.8.8.8). */
export const MAX_DNS: Zone = {
  '_dmarc.readysetmail.com': { TXT: [REC] },
  '_dmarc.app.readysetmail.com': { TXT: [REC] },
  'readysetmail.com': { TXT: ['v=spf1 include:_spf.protonmail.ch ~all'], MX: ['10 mail.protonmail.ch.'], A: ['216.150.16.129'] },
  'app.readysetmail.com': { A: ['104.21.85.16'] },
  'rua.readysetmail.com': { TXT: ['v=spf1 include:_spf.mx.cloudflare.net ~all'], MX: ['5 route3.mx.cloudflare.net.'] },
  'cf-bounce.app.readysetmail.com': { TXT: ['v=spf1 include:_spf.mx.cloudflare.net ~all'], MX: ['5 route3.mx.cloudflare.net.'] },
  'cf-bounce._domainkey.app.readysetmail.com': { TXT: ['v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkq'] },
  '_spf.protonmail.ch': { TXT: ['v=spf1 ip4:185.70.40.0/24 ~all'] },
  '_spf.mx.cloudflare.net': { TXT: ['v=spf1 ip4:104.30.0.0/19 ~all'] },
};

const CODES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, PTR: 12 };

/** A fake DoH over `zone`: a name with records (or a name below one) exists; every other name is NXDOMAIN. */
export function dnsFetch(zone: Zone) {
  return async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const name = (u.searchParams.get('name') ?? '').toLowerCase().replace(/\.$/, '');
    const type = (u.searchParams.get('type') ?? 'A').toUpperCase();
    const node = zone[name];
    const exists = node || Object.keys(zone).some((k) => k.endsWith(`.${name}`));
    if (!exists) return new Response(JSON.stringify({ Status: 3 }), { status: 200 });
    const data = node?.[type] ?? [];
    return new Response(JSON.stringify({ Status: 0, ...(data.length ? { Answer: data.map((d) => ({ name, type: CODES[type] ?? 16, TTL: 60, data: type === 'TXT' ? `"${d}"` : d })) } : {}) }), { status: 200 });
  };
}

/** One record of a report: the From domain, the SPF (MAIL FROM) domain, the DKIM d=, whether the RECEIVER found each aligned, and the message count. */
export interface Row { from: string; spf: string; dkim: string; spfAligned: boolean; dkimAligned: boolean; n: number; spfResult?: string; dkimResult?: string }

export function reportXml(policyDomain: string, id: string, rows: Row[], opts: { org?: string; aspf?: 'r' | 's'; adkim?: 'r' | 's'; p?: string; sp?: string; np?: string } = {}): string {
  const org = opts.org ?? 'google.com';
  const recs = rows.map((r, i) => `<record><row><source_ip>203.0.113.${i + 1}</source_ip><count>${r.n}</count>
  <policy_evaluated><disposition>none</disposition><dkim>${r.dkimAligned ? 'pass' : 'fail'}</dkim><spf>${r.spfAligned ? 'pass' : 'fail'}</spf></policy_evaluated></row>
  <identifiers><header_from>${r.from}</header_from></identifiers>
  <auth_results><dkim><domain>${r.dkim}</domain><result>${r.dkimResult ?? 'pass'}</result></dkim><spf><domain>${r.spf}</domain><result>${r.spfResult ?? 'pass'}</result></spf></auth_results></record>`).join('\n');
  const now = Math.floor(Date.now() / 1000);
  return `<?xml version="1.0"?><feedback><report_metadata><org_name>${org}</org_name><email>noreply-dmarc-support@${org}</email><report_id>${id}</report_id>
  <date_range><begin>${now - 2 * 86400}</begin><end>${now - 86400}</end></date_range></report_metadata>
  <policy_published><domain>${policyDomain}</domain><adkim>${opts.adkim ?? 'r'}</adkim><aspf>${opts.aspf ?? 'r'}</aspf><p>${opts.p ?? 'reject'}</p><sp>${opts.sp ?? opts.p ?? 'reject'}</sp><pct>100</pct></policy_published>${recs}</feedback>`;
}

const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' }, from: 'noreply-dmarc-support@google.com' };
const mime = (x: string) => mimeWithAttachment(gzipSync(strToU8(x)), 'r.xml.gz', 'application/gzip');

export function quietConsole() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

/** A hosted workspace owned by the operator, with readysetmail.com proven and its reports connected, and `zone` as public DNS. */
export async function hostedOwner(zone: Zone = MAX_DNS) {
  vi.stubGlobal('fetch', dnsFetch(zone));
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV, HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'owner@example.com' }) as any;
  const token = await signupVerified(env, 'owner@example.com');
  const rows = (s: string, ...p: unknown[]) => db.sqlite.prepare(s).all(...p) as any[];
  const ws = rows("SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'owner@example.com'")[0].workspace_id;
  db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via, reports_connected_at) VALUES (1, ?, 'readysetmail.com', ?, 'txt', 1)").run(ws, FIXED);
  const send = async (x: string) => {
    const m = fakeMessage(FIXED, mime(x), GOOGLE);
    await handleHostedEmail(m, env);
    return { rejected: m.setReject.mock.calls.map((c: any[]) => c[0]) };
  };
  const filed = () => rows('SELECT ar.report_id, d.domain AS filed_under, ar.total_count, ar.pass_count, ar.fail_count FROM aggregate_reports ar JOIN domains d ON d.id = ar.domain_id ORDER BY ar.id');
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await call(env, method, path, { key: token, ...(body !== undefined ? { body } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { db, env, ws, rows, send, filed, api };
}
