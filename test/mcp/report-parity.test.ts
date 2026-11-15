import { describe, it, expect } from 'vitest';
import { toolWorld } from './tool-fixture';
import { getDomainReport } from '../../src/reports/service';
import { loadTenant } from '../../src/tenancy/load';
describe('MCP shared report parity', () => {
 it('returns identical evidence/fixes to the HTTP/dashboard report service', async () => {
  const world = await toolWorld(), client = await world.connect();
  const id = Number((await world.scope.domains.insert({ domain: 'example.com', rua_address: '' })).meta.last_row_id);
  const canonical = await getDomainReport(await loadTenant(world.tenant.env, { workspaceId: world.tenant.workspaceId }), id, world.context.reportOptions);
  const actual = await client.callTool({ name: 'get_email_report', arguments: { domain: 'example.com' } });
  expect((actual.structuredContent as any).data.report).toEqual(canonical);
  const metrics = await client.callTool({ name: 'query_email_metrics', arguments: { domain: 'example.com', source: 'dmarc' } });
  expect((metrics.structuredContent as any).data.sections.dmarc).toEqual(canonical.sections.dmarc);
  const remediation = await client.callTool({ name: 'plan_remediation', arguments: { domain: 'example.com' } });
  expect((remediation.structuredContent as any).data.fixes).toEqual(canonical.remediation);
  await client.close();
 });
});

describe('MCP DMARC step: the same rule and inputs as the dashboard', () => {
 const NOW = Math.floor(Date.now() / 1000);
 it('returns the step from get_email_report and plan_remediation only; query_email_metrics does not compute it', async () => {
  const world = await toolWorld(), client = await world.connect();
  await world.scope.domains.insert({ domain: 'example.com', rua_address: 'rua@reports.example.net' });
  for (const name of ['get_email_report', 'plan_remediation']) {
   const r = await client.callTool({ name, arguments: { domain: 'example.com' } });
   expect((r.structuredContent as any).data).toHaveProperty('dmarc');
  }
  const metrics = await client.callTool({ name: 'query_email_metrics', arguments: { domain: 'example.com' } });
  expect((metrics.structuredContent as any).data).not.toHaveProperty('dmarc');
  await client.close();
 });

 it('counts a reports address only when the dashboard would (one mailbox), and says when a listed parent is a public suffix', async () => {
  const { dmarcNextStep } = await import('../../src/mcp/tools/index');
  const summary = (o: Record<string, unknown>) => ({ dns_checked_at: NOW, dmarc_policy: null, dmarc_issue: null, dmarc_inherited_from: null, dmarc_pct: null, dmarc_p: null, dmarc_sp: null, dmarc_rua: null, total_messages: 0, pass_messages: 0, ...o });
  const rows: Record<number, any> = {
   1: summary({ dmarc_policy: 'none', dmarc_p: 'none', dmarc_pct: 100, dmarc_rua: 1 }),
   2: summary({ dmarc_policy: 'reject', dmarc_p: 'reject', dmarc_sp: 'none', dmarc_pct: 100 }), // gov.uk
   3: summary({}), // www.gov.uk: read, no record covers it
  };
  const tenant = { scope: { reports: { checkSummary: async (id: number) => rows[id] ?? null }, domains: { getById: async (id: number) => ({ 2: { id: 2, domain: 'gov.uk' } } as any)[id] ?? null } } };
  // Not one mailbox: the dashboard's hasReportAddress says no, so does the agent (connect reports, not "wait for reports").
  const bad = await dmarcNextStep(tenant, { id: 1, domain: 'a.example', rua_address: 'a@b.example, c@d.example' }, NOW);
  expect(bad!.next_step).toMatchObject({ key: 'connect-reports' });
  const good = await dmarcNextStep(tenant, { id: 1, domain: 'a.example', rua_address: 'rua@reports.example.net' }, NOW);
  expect(good!.next_step).toMatchObject({ key: 'gathering' });
  const suffix = await dmarcNextStep(tenant, { id: 3, domain: 'www.gov.uk', rua_address: 'rua@reports.example.net', parent_id: 2 }, NOW);
  expect(suffix!.next_step).toMatchObject({ key: 'dmarc-missing' });
  expect(suffix!.next_step!.why).toMatch(/gov\.uk is a public suffix, so its DMARC record does not apply to www\.gov\.uk/);
  expect(JSON.stringify(suffix)).not.toContain('rua@reports.example.net');
 });

 // The dashboard's builder (web/src/lib/dmarc-step.ts evidenceFor) is a thin call to the same dmarcEvidenceFor, so the agent
 // must reach the dashboard's step for the same inputs: a hosted customer who may not connect reports, and reports that
 // arrived but were not counted.
 it('a domain whose reports cannot be connected gets the dashboard\'s "Check each service" step, not "Connect reports"', async () => {
  const { dmarcNextStep } = await import('../../src/mcp/tools/index');
  const row = { dns_checked_at: NOW, dmarc_policy: 'none', dmarc_issue: null, dmarc_inherited_from: null, dmarc_pct: 100, dmarc_p: 'none', dmarc_sp: null, dmarc_rua: 0, total_messages: 0, pass_messages: 0 };
  const tenant = { scope: { reports: { checkSummary: async () => row }, domains: { getById: async () => null } } };
  const refused = { can_connect: false, refusal: "On this server, only the operator's workspaces can connect reports.", refusal_kind: 'operator_only' as const };
  const r = await dmarcNextStep(tenant, { id: 1, domain: 'cust.example', rua_address: '' }, NOW, { reportConnect: async () => refused, visibility: async () => null });
  expect(r!.next_step).toMatchObject({ key: 'check-senders', do: 'Check each service that sends as cust.example, then move to p=quarantine' });
  expect(JSON.stringify(r)).not.toContain('Connect reports so senders can be confirmed');
 });

 it('reports that arrived but were not counted are named, never "No reports arrived"', async () => {
  const { dmarcNextStep } = await import('../../src/mcp/tools/index');
  const row = { dns_checked_at: NOW, dmarc_policy: 'none', dmarc_issue: null, dmarc_inherited_from: null, dmarc_pct: 100, dmarc_p: 'none', dmarc_sp: null, dmarc_rua: 1, total_messages: 0, pass_messages: 0 };
  const tenant = { scope: { reports: { checkSummary: async () => row }, domains: { getById: async () => null } } };
  const visibility = { counting_note: null, uncounted: { reports: 2, unknown: 2, unauthenticated: 0 }, intake: { status: 'ok' as const, notice: null, dropped: [] } };
  const r = await dmarcNextStep(tenant, { id: 1, domain: 'a.example', rua_address: 'rua@reports.example.net' }, NOW, { reportConnect: async () => null, visibility: async () => visibility });
  expect(r!.next_step!.why).toContain('No counted reports yet. 2 reports from senders we do not recognise are not counted.');
  expect(r!.next_step!.why).not.toContain('No reports arrived');
  const dropped = { counting_note: null, uncounted: { reports: 0 }, intake: { status: 'limited' as const, notice: 'x', dropped: [{ label: 'Google', since: '2026-11-14T03:12:00.000Z', text: 'Report storage limit reached; reports from Google since 2026-11-14 03:12 UTC were not stored' }] } };
  const d = await dmarcNextStep(tenant, { id: 1, domain: 'a.example', rua_address: 'rua@reports.example.net' }, NOW, { reportConnect: async () => null, visibility: async () => dropped });
  expect(d!.next_step!.why).toContain('Report storage limit reached; reports from Google since 2026-11-14 03:12 UTC were not stored');
 });
});
