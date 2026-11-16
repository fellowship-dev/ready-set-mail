// Review probe for PR 180: failing mail must never stop the customer's own (passing) reports from being recorded.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.setConfig({ testTimeout: 300_000 });
vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { handleHostedEmail } from '../../src/hosted/intake';
import { fakeMessage, gzipReportMime } from '../helpers/mail';
import { nxdomain, quiet, twoWorkspaces } from '../hosted/world';
const RUA = 'rua.readysetmail.com';
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };
const BIG = { INTAKE_MAX_DECOMPRESSED_BYTES: String(40 * 1024 * 1024), INTAKE_MAX_RAW_BYTES: String(40 * 1024 * 1024) };
beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function report(id: string, pass: number, fail: number): string {
  const rec = (ip: string, ok: boolean) => `<record><row><source_ip>${ip}</source_ip><count>1</count><policy_evaluated><disposition>${ok ? 'none' : 'reject'}</disposition><dkim>${ok ? 'pass' : 'fail'}</dkim><spf>${ok ? 'pass' : 'fail'}</spf></policy_evaluated></row><identifiers><header_from>a-corp.com</header_from></identifiers></record>`;
  const rows: string[] = [];
  for (let i = 0; i < pass; i++) rows.push(rec(`198.51.${(i >> 8) & 255}.${(i & 255) + 1}`, true));
  for (let i = 0; i < fail; i++) rows.push(rec(`${10 + ((i >> 16) & 100)}.${(i >> 8) & 255}.${i & 255}.${(i % 250) + 1}`, false));
  return `<?xml version="1.0"?><feedback><report_metadata><org_name>google.com</org_name><email>noreply-dmarc-support@google.com</email><report_id>${id}</report_id><date_range><begin>1529366400</begin><end>1529452799</end></date_range></report_metadata><policy_published><domain>a-corp.com</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><pct>100</pct></policy_published>${rows.join('')}</feedback>`;
}
describe('P7 one big spoofing day in ONE report', () => {
  for (const fail of [19_000, 25_000, 100_000]) {
    it(`Google's daily report with 40 passing rows and ${fail} failing rows: the passing rows are recorded`, async () => {
      const w = await twoWorkspaces({ HOSTED_PLAN: 'free_one_domain', OWNER_EMAIL: 'operator@example.com', ...BIG });
      (w.env as any).SEND_EMAIL = { send: vi.fn(async () => {}) };
      const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(report(`big-${fail}`, 40, fail)), GOOGLE);
      await handleHostedEmail(m, w.env);
      const stored = w.rows("SELECT COUNT(*) AS n FROM report_records r JOIN aggregate_reports a ON a.id = r.report_id WHERE a.report_id LIKE ?", `%big-${fail}`)[0].n;
      const failures = w.rows('SELECT reason, messages FROM intake_failures');
      console.info(`P7 fail=${fail} rejected=${(m.setReject as any).mock.calls.length ? JSON.stringify((m.setReject as any).mock.calls[0]) : 'no'} stored_rows=${stored} failures=${JSON.stringify(failures)} p=${JSON.stringify(w.rows("SELECT scope, records FROM intake_quota WHERE scope LIKE 'p:%' OR scope LIKE 'f:%'"))}`);
      expect(m.setReject).not.toHaveBeenCalled();
      expect(stored).toBeGreaterThanOrEqual(40);
    });
  }
});
