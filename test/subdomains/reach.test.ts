// BLOCKER 1 (PR 181 round 3): ONE answer to "do reports reach this name, and how" (`reportReachOf`, on the report-address view as `reach`).
// A subdomain whose reports arrive through its parent was told it had none; a connected row with counted reports was "waiting for the first report";
// a name that inherits a record that already lists our address was told its record "does not list the report address". Every surface reads `reach`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { reportReachWords } from '@ready-set-mail/dns-checks';
import { dmarcNextStep } from '../../src/mcp/tools/index';
import { loadTenant } from '../../src/tenancy/load';
import { FIXED, hostedOwner, quietConsole, reportXml } from './world';

beforeEach(() => { resetSchemaReadyCache(); quietConsole(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const row = (from: string, n: number, over: Record<string, unknown> = {}) => ({ from, spf: from, dkim: from, spfAligned: true, dkimAligned: true, n, ...over });
const idOf = (w: Awaited<ReturnType<typeof hostedOwner>>, name: string) => w.rows('SELECT id FROM domains WHERE domain = ?', name)[0].id as number;

/** The owner's case: app. added as its own domain (it publishes its own record naming our address); a report about it was filed under the parent first, then one under it. */
async function appAdded() {
  const w = await hostedOwner();
  // before app. was added: the report names app. as its policy domain and files under the connected parent
  expect((await w.send(reportXml('app.readysetmail.com', 'r-before', [row('app.readysetmail.com', 5)]))).rejected).toEqual([]);
  expect(w.filed()).toEqual([expect.objectContaining({ filed_under: 'readysetmail.com', total_count: 5 })]);
  expect((await w.api('POST', '/api/domains', { domain: 'app.readysetmail.com' })).status).toBe(201);
  expect((await w.send(reportXml('app.readysetmail.com', 'r-after', [row('app.readysetmail.com', 7)]))).rejected).toEqual([]);
  expect(w.filed().map((f: any) => f.filed_under)).toEqual(['readysetmail.com', 'app.readysetmail.com']);
  return { w, appId: idOf(w, 'app.readysetmail.com') };
}

describe('state (a): no connection of its own, reports filed under it through the connected parent', () => {
  it('the view says so with the real counts, and the one wording says "Reports arrive through readysetmail.com" with nothing to connect', async () => {
    const { w, appId } = await appAdded();
    const s = (await w.api('GET', `/api/domains/${appId}/report-address`)).body;
    expect(s).toMatchObject({ address: null, state: 'not_connected', via_parent: { domain: 'readysetmail.com' }, reach: { kind: 'via_parent', through: { domain: 'readysetmail.com' }, reports: 1, messages: 7, days: 30 } });
    expect(s.reach.last_report_at).toEqual(expect.any(Number));
    const words = reportReachWords('app.readysetmail.com', s.reach, () => 'TIME')!;
    expect(words.headline).toBe('Reports arrive through readysetmail.com');
    expect(words.sentences.join(' ')).toContain('1 report (7 messages) filed for app.readysetmail.com in the last 30 days; the last arrived TIME.');
    expect(words.sentences.join(' ')).toContain('Connecting app.readysetmail.com would change nothing: it uses the same report address.');
  });

  it('the list, the stored check and the agent answer the same: the row carries the address and the agent report says how reports arrive, with the counts', async () => {
    const { w, appId } = await appAdded();
    const list = (await w.api('GET', '/api/domains')).body.domains as any[];
    expect(list.find((d) => d.domain === 'app.readysetmail.com')).toMatchObject({ rua_address: FIXED, reports_via: { domain: 'readysetmail.com' } });
    // the setup steps read the same address from onboarding-status (step 4 and 5 are not "no reports reach")
    expect((await w.api('GET', `/api/domains/${appId}/onboarding-status`)).body.rua_address).toBe(FIXED);
    // the agent: dmarcNextStep is what get_email_report and plan_remediation return
    const agent = await agentStep(w, appId);
    expect(agent.reports_reach).toMatchObject({ kind: 'via_parent', through: { domain: 'readysetmail.com' }, reports: 1, messages: 7 });
    expect(agent.reports_reach.summary).toContain('Reports arrive through readysetmail.com.');
    expect(agent.reports_reach.summary).toContain('1 report (7 messages) filed for app.readysetmail.com in the last 30 days');
    expect(JSON.stringify(agent.steps)).not.toContain('Connect reports');
  });
});

async function agentStep(w: Awaited<ReturnType<typeof hostedOwner>>, id: number) {
  const tenant = await loadTenant(w.env, { workspaceId: w.ws });
  const domain = await tenant.scope.domains.getById(id);
  return (await dmarcNextStep(tenant as any, domain as any))!;
}

describe('a connected row with counted reports stored for it is receiving, never "waiting for the first report"', () => {
  it('reports filed under the same fixed address before this row was connected count: state receiving, with the last counted report', async () => {
    const { w, appId } = await appAdded();
    const c = await w.api('POST', `/api/domains/${appId}/report-address`, {});
    expect(c.body).toMatchObject({ address: FIXED, state: 'receiving', reach: { kind: 'own', reports: 1 } });
    expect(c.body.last_report_at).toEqual(expect.any(Number));
    expect(reportReachWords('app.readysetmail.com', c.body.reach, () => 'TIME')).toEqual({ headline: 'Reports received', sentences: ['Last counted report received TIME.'], tone: 'ok' });
  });
  it('waiting only when no counted report for this name exists at all', async () => {
    const w = await hostedOwner();
    await w.api('POST', '/api/domains', { domain: 'app.readysetmail.com' });
    const id = idOf(w, 'app.readysetmail.com');
    const c = await w.api('POST', `/api/domains/${id}/report-address`, {});
    expect(c.body).toMatchObject({ address: FIXED, state: 'waiting', last_report_at: null, reach: { kind: 'own', reports: 0, last_report_at: null } });
    expect(reportReachWords('app.readysetmail.com', c.body.reach, () => 'TIME')).toEqual({ headline: 'Published, waiting for the first report', sentences: ['Your DMARC record lists the report address. Receivers send reports about once a day, so the first one can take a day or two.'], tone: 'info' });
  });
});

describe('state (b): no DMARC record of its own, the record that applies lists our address', () => {
  async function cfBounceAdded() {
    const { w, appId } = await appAdded();
    expect((await w.api('POST', '/api/domains', { domain: 'cf-bounce.app.readysetmail.com' })).status).toBe(201);
    return { w, appId, cfId: idOf(w, 'cf-bounce.app.readysetmail.com') };
  }
  it('says which record applies and that it already sends reports here; nothing to connect, nothing to publish', async () => {
    const { w, cfId } = await cfBounceAdded();
    const s = (await w.api('GET', `/api/domains/${cfId}/report-address`)).body;
    expect(s).toMatchObject({ address: null, reach: { kind: 'inherited_record', through: { domain: 'readysetmail.com' } } });
    const words = reportReachWords('cf-bounce.app.readysetmail.com', s.reach, () => 'TIME')!;
    expect(words.headline).toBe("Reports arrive through readysetmail.com's record");
    expect(words.sentences).toEqual(["cf-bounce.app.readysetmail.com has no DMARC record of its own. readysetmail.com's record applies to it and already sends reports here; mail sent as cf-bounce.app.readysetmail.com is counted in readysetmail.com's reports."]);
  });
  it('connected, the state is never "not published": the record that applies is the parent\'s and lists the address', async () => {
    const { w, cfId } = await cfBounceAdded();
    const c = await w.api('POST', `/api/domains/${cfId}/report-address`, {});
    expect(c.body.reach).toMatchObject({ kind: 'inherited_record', through: { domain: 'readysetmail.com' } });
    expect(['waiting', 'receiving']).toContain(c.body.state);
    expect(c.body.dns.plan).toMatchObject({ kind: 'inherited', from: 'readysetmail.com', parent_has_address: true });
  });
  it('the agent says the same, not "connect reports" and not "publish a record"', async () => {
    const { w, cfId } = await cfBounceAdded();
    const agent = await agentStep(w, cfId);
    expect(agent.reports_reach).toMatchObject({ kind: 'inherited_record', through: { domain: 'readysetmail.com' } });
    expect(agent.reports_reach.summary).toContain("Reports arrive through readysetmail.com's record.");
    expect(JSON.stringify(agent.steps)).not.toContain('Connect reports');
  });
  it('its Analytics readiness is judged by the policy in force for it, as the workspace table does, not "no DMARC record" beside "inherits p=reject"', async () => {
    const { w, cfId } = await cfBounceAdded();
    await w.api('GET', `/api/domains/${cfId}/onboarding-status`); // stores the policy in force for the name (p=reject from readysetmail.com)
    const a = (await w.api('GET', `/api/domains/${cfId}/analytics?days=30`)).body;
    expect(a.readiness).toMatchObject({ status: 'complete', policy_source: 'stored', current: { policy: 'reject' } });
    const ws = (await w.api('GET', '/api/analytics?days=30')).body;
    expect(ws.domains.find((d: any) => d.domain_id === cfId).readiness.status).toBe('complete');
  });
  it('a name nothing reaches (no connected ancestor) says none', async () => {
    const w = await hostedOwner();
    w.db.sqlite.prepare("UPDATE domains SET rua_address = '', reports_connected_at = NULL WHERE id = 1").run();
    await w.api('POST', '/api/domains', { domain: 'app.readysetmail.com' });
    const s = (await w.api('GET', `/api/domains/${idOf(w, 'app.readysetmail.com')}/report-address`)).body;
    expect(s.reach).toMatchObject({ kind: 'none', through: null });
  });
});
