// "First report received": one module for both modes (src/notifications/first-report.ts, the email itself in src/lifecycle/email/).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { makeTenant } from '../helpers/tenant';
import { sendFirstReportNotification } from '../../src/notifications/first-report';
import { storeReport } from '../../src/dmarc/store-report';
import { lifecycleWorld, MON_16_NOV, DAY } from '../lifecycle/email/world';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const quiet = () => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); };

// ── Self-host: the workspace's own sender, the instance's own address ─

function selfHost(o: { owner?: boolean; customDomain?: string | null; sendEmail?: boolean; publicBaseUrl?: string | null } = {}) {
  const db = createMigratedD1();
  if (o.owner !== false) {
    db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'admin@acme.com', 'Acme Admin', 'admin')").run();
    db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES ('ws_default', 'u1', 'owner')").run();
  }
  if (o.customDomain !== null) db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'custom_domain', ?)").run(o.customDomain ?? 'inbox.acme.com');
  db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'acme.com', 'rua@reports.acme.com')").run();
  const send = vi.fn().mockResolvedValue(undefined);
  const tenant = makeTenant({
    db,
    env: { ...(o.sendEmail === false ? {} : { SEND_EMAIL: { send } as any }), ...(o.publicBaseUrl === null ? {} : { PUBLIC_BASE_URL: o.publicBaseUrl ?? 'https://app.acme.com' }) },
    settings: { fromEmail: 'noreply@reports.acme.com', workersSubdomain: 'testaccount' },
  });
  return { db, send, tenant };
}

function addReport(db: ReturnType<typeof createMigratedD1>, over: { total?: number; passed?: number } = {}) {
  const total = over.total ?? 150, passed = over.passed ?? 140;
  db.sqlite.prepare("INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, reporter_known_as) VALUES (1, 1, 'google.com', 'r1', 1718236800, 1718323199, ?, ?, ?, 'Google')").run(total, passed, total - passed);
  db.sqlite.prepare("INSERT INTO report_records (report_id, source_ip, count, disposition, dkim_result, dkim_domain, spf_result, spf_domain, header_from, org, spf_aligned, dkim_aligned) VALUES (1, '192.0.2.10', ?, 'none', 'pass', 'acme.com', 'pass', 'acme.com', 'acme.com', 'Acme Mail', 1, 1)").run(passed);
  if (total > passed) db.sqlite.prepare("INSERT INTO report_records (report_id, source_ip, count, disposition, dkim_result, dkim_domain, spf_result, spf_domain, header_from, org, spf_aligned, dkim_aligned) VALUES (1, '198.51.100.7', ?, 'none', 'pass', 'sendgrid.net', 'fail', null, 'acme.com', 'SendGrid', 0, 0)").run(total - passed);
}

describe('sendFirstReportNotification (self-host)', () => {
  it('sends the new email to the owner from the workspace\'s own address, with the dashboard link on the public origin', async () => {
    quiet();
    const s = selfHost();
    addReport(s.db);
    await sendFirstReportNotification(s.tenant, undefined, 1, 1);
    expect(s.send).toHaveBeenCalledOnce();
    const m = s.send.mock.calls[0][0];
    expect(m.from).toEqual({ name: 'Ready Set Mail', email: 'noreply@reports.acme.com' });
    expect(m.to).toEqual(['admin@acme.com']);
    expect(m.subject).toBe('First DMARC report for acme.com: 150 messages, 140 passed');
    expect(m.text).toContain('Hi Acme,');
    expect(m.text).toContain('Google sent the first DMARC report for acme.com.');
    expect(m.text).toContain('Worth a look: 10 messages from SendGrid (198.51.100.7) did not pass DMARC. They passed DKIM for sendgrid.net, but not for acme.com.');
    expect(m.text).toContain('https://app.acme.com/#/w/ws_default/domains/1');
    expect(m.text + m.html).not.toContain('inbox.acme.com'); // the custom domain setting is not where links point: PUBLIC_BASE_URL is
    // The old copy is gone: no celebration, no emoji, no "24-48 hours".
    expect(m.subject + m.text + m.html).not.toMatch(/Great news|\p{Extended_Pictographic}|24-48/u);
  });

  it('every link is the public origin; with none configured the email goes without a button, never with a workers.dev or custom-domain address', async () => {
    quiet();
    const pub = selfHost({ publicBaseUrl: 'https://mail.example.org' });
    addReport(pub.db);
    await sendFirstReportNotification(pub.tenant, undefined, 1, 1);
    expect(pub.send.mock.calls[0][0].text).toContain('https://mail.example.org/#/w/ws_default/domains/1');
    const dev = selfHost({ publicBaseUrl: null });
    addReport(dev.db);
    await sendFirstReportNotification(dev.tenant, undefined, 1, 1);
    expect(dev.send).toHaveBeenCalledOnce();
    const m = dev.send.mock.calls[0][0];
    expect(m.text + m.html).not.toMatch(/workers\.dev|inbox\.acme\.com|https?:\/\//);
  });

  it('sends once: a second call for the same report sends nothing', async () => {
    quiet();
    const s = selfHost();
    addReport(s.db, { total: 10, passed: 10 });
    await sendFirstReportNotification(s.tenant, undefined, 1, 1);
    await sendFirstReportNotification(s.tenant, undefined, 1, 1);
    expect(s.send).toHaveBeenCalledOnce();
    expect(s.send.mock.calls[0][0].subject).toBe('First DMARC report for acme.com: 10 messages, all passed');
  });

  it('does not throw and does not claim anything when no mail can be sent (no binding), or nobody owns the workspace', async () => {
    quiet();
    const none = selfHost({ sendEmail: false });
    addReport(none.db);
    await expect(sendFirstReportNotification(none.tenant, undefined, 1, 1)).resolves.toBeUndefined();
    expect(none.db.sqlite.prepare('SELECT COUNT(*) AS n FROM lifecycle_sends').get()).toEqual({ n: 0 });
    const nobody = selfHost({ owner: false });
    addReport(nobody.db);
    await expect(sendFirstReportNotification(nobody.tenant, undefined, 1, 1)).resolves.toBeUndefined();
    expect(nobody.send).not.toHaveBeenCalled();
  });

  it('does not need a verified address on self-host (nobody is asked to verify one there)', async () => {
    quiet();
    const s = selfHost();
    expect(s.db.sqlite.prepare('SELECT email_verified FROM users').get()).toEqual({ email_verified: 0 });
    addReport(s.db);
    await sendFirstReportNotification(s.tenant, undefined, 1, 1);
    expect(s.send).toHaveBeenCalledOnce();
  });
});

describe('hosted: the platform sender, never the per-workspace setting that does not exist there', () => {
  it('sends from senderAddress(env) although the tenant has no fromEmail, to the owner, through the claim', async () => {
    const w = await lifecycleWorld();
    const id = w.addDomain({ domain: 'brightwave-mail.com' });
    const rid = w.addReport({ domain: 'brightwave-mail.com', day: MON_16_NOV - DAY, records: [{ ip: '192.0.2.10', count: 14, spf: ['pass', 'brightwave-mail.com'], dkim: ['pass', 'brightwave-mail.com'], org: 'Google Workspace' }] });
    const tenant = w.tenant();
    expect(tenant.settings.fromEmail).toBeUndefined();
    const { sendFirstReportNow } = await import('../../src/lifecycle/email/run');
    await sendFirstReportNow(tenant, w.ctx, id, rid, w.deps);
    expect(w.mailer.sent).toHaveLength(1);
    expect(w.mailer.sent[0].from.email).toBe('noreply@app.readysetmail.com');
    expect(w.mailer.sent[0].to).toBe('dana@brightwave-mail.com');
    expect(w.rows('SELECT kind, period, state FROM lifecycle_sends')).toEqual([{ kind: 'first_report', period: 'once', state: 'sent' }]);
  });
});

// ── The trigger in storeReport ────────────────────────────────

function parsedReport() {
  return {
    xml_schema: 'draft' as const,
    report_metadata: { org_name: 'google.com', org_email: 'noreply@google.com', org_extra_contact_info: null, report_id: 'report-001', begin_date: '2024-06-13T00:00:00Z', end_date: '2024-06-13T23:59:59Z', errors: [] },
    policy_published: { domain: 'acme.com', adkim: 'r' as const, aspf: 'r' as const, p: 'reject' as const, sp: 'reject' as const, pct: 100, fo: '0' },
    records: [{
      source: { ip: '1.2.3.4', reverse_dns: null, base_domain: null, country_code: null, country_name: null, subdivision: null, city: null },
      count: 10,
      alignment: { spf: true, dkim: true, dmarc: true },
      policy_evaluated: { disposition: 'none' as const, dkim: 'pass' as const, spf: 'pass' as const, policy_override_reasons: [] },
      identifiers: { header_from: 'acme.com', envelope_from: null, envelope_to: null },
      auth_results: { dkim: [{ domain: 'acme.com', selector: 'sel', result: 'pass' as const }], spf: [{ domain: 'acme.com', scope: 'mfrom', result: 'pass' as const }] },
    }],
  };
}

function storeWorld(opts: { existingReports?: number; duplicate?: boolean } = {}) {
  const { existingReports = 0, duplicate = false } = opts;
  const db = createMigratedD1();
  db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'acme.com', 'rua@reports.acme.com')").run();
  db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'admin@acme.com', 'Admin', 'admin')").run();
  db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES ('ws_default', 'u1', 'owner')").run();
  for (let i = 0; i < existingReports; i++) db.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end) VALUES (1, 'x', ?, 0, 1)").run(i === 0 && duplicate ? 'report-001' : `old-${i}`);
  const send = vi.fn().mockResolvedValue(undefined);
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p); } };
  return { db, send, ctx, waited, tenant: makeTenant({ db, env: { SEND_EMAIL: { send } as any }, settings: { fromEmail: 'noreply@reports.acme.com' } }) };
}

describe('storeReport first-report trigger', () => {
  it('sends on the first counted report, inside ctx.waitUntil so it is not cut off when the delivery ends', async () => {
    quiet();
    const s = storeWorld();
    await storeReport(s.tenant, 1, parsedReport(), null, true, undefined, s.ctx);
    expect(s.waited).toHaveLength(1); // handed to waitUntil, not floating
    await Promise.all(s.waited);
    expect(s.send).toHaveBeenCalledOnce();
    expect(s.send.mock.calls[0][0].subject).toBe('First DMARC report for acme.com: 10 messages, all passed');
  });

  it('does NOT send on later reports (count > 1), on a duplicate, or when it is not requested', async () => {
    quiet();
    const later = storeWorld({ existingReports: 4 });
    await storeReport(later.tenant, 1, parsedReport(), null, true, undefined, later.ctx);
    await Promise.all(later.waited);
    expect(later.send).not.toHaveBeenCalled();
    const dup = storeWorld({ existingReports: 1, duplicate: true });
    await storeReport(dup.tenant, 1, parsedReport(), null, true, undefined, dup.ctx);
    await Promise.all(dup.waited);
    expect(dup.send).not.toHaveBeenCalled();
    const off = storeWorld();
    await storeReport(off.tenant, 1, parsedReport());
    await new Promise((r) => setTimeout(r, 10));
    expect(off.send).not.toHaveBeenCalled();
  });

  it('without a context it still sends (the promise runs), and a failure never fails the report', async () => {
    quiet();
    const s = storeWorld();
    s.send.mockRejectedValue(new Error('provider down'));
    await expect(storeReport(s.tenant, 1, parsedReport(), null, true)).resolves.toMatchObject({ stored: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.send).toHaveBeenCalled();
  });
});
