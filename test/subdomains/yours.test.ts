// PR 181 round 3, BLOCKER 2: ONE judgement of "is this failing source the owner's to fix" (`classifySource`) feeds the next step, the names panel,
// Analytics and the agent report. Before: readysetmail.com's page said "Nothing to fix" and "2 names to fix" while Analytics rated the same failures
// "High impact". Three cases, each on every surface: (1) only spoofers, (2) one unaligned real service, (3) a mix (the owner's case).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { dmarcNextStep } from '../../src/mcp/tools/index';
import { loadTenant } from '../../src/tenancy/load';
import { hostedOwner, quietConsole, reportXml, type Row } from './world';

beforeEach(() => { resetSchemaReadyCache(); quietConsole(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const RSM = 'readysetmail.com';
const pass = (n: number): Row => ({ from: RSM, spf: RSM, dkim: RSM, spfAligned: true, dkimAligned: true, n });
/** A spoofer: authenticated as nobody (SPF and DKIM both fail), sending as `from`. */
const spoofer = (n: number, from = RSM): Row => ({ from, spf: 'spoof.example', dkim: 'spoof.example', spfAligned: false, dkimAligned: false, n, spfResult: 'fail', dkimResult: 'fail' });
/** A real mail service sending as `from` without alignment: SPF and DKIM both pass, for ITS domains. */
const service = (n: number, from = 'rua.readysetmail.com'): Row => ({ from, spf: 'bounce.other-provider.example', dkim: 'some-other-domain.example', spfAligned: false, dkimAligned: false, n });

async function world(rows: Row[]) {
  const w = await hostedOwner();
  expect((await w.send(reportXml(RSM, 'r-yours-1', rows))).rejected).toEqual([]);
  await w.api('GET', '/api/domains/1/onboarding-status'); // stores the policy in force (p=reject), as the page's own read does
  const names = (await w.api('GET', '/api/domains/1/names?days=30')).body.names as any[];
  const analytics = (await w.api('GET', '/api/domains/1/analytics?days=30')).body;
  const tenant = await loadTenant(w.env, { workspaceId: w.ws });
  const agent = (await dmarcNextStep(tenant as any, (await tenant.scope.domains.getById(1)) as any))!;
  const summary = (await w.api('GET', '/api/domains/1/check-summary')).body;
  return { w, names, analytics, agent, summary };
}
const sentences = (steps: any[]) => steps.map((s) => `${s.do} ${s.why}`).join(' ');

describe('case 1: only spoofers fail', () => {
  it('the next step, the names panel, Analytics and the agent all say nothing to fix', async () => {
    const { names, analytics, agent, summary } = await world([pass(90), spoofer(6), spoofer(4, 'rua.readysetmail.com')]);
    expect(summary).toMatchObject({ failed_not_yours: 10, failed_service: 0 });
    // next step (the agent's is the dashboard's: the same dmarcSteps and evidence)
    expect(agent.next_step).toMatchObject({ key: 'done', do: 'Nothing to do' });
    expect(agent.steps.find((s: any) => s.key === 'not-yours')).toMatchObject({ do: 'Nothing to fix', status: 'note' });
    // names panel: counted as nothing to fix, never "to fix" and never "to look at"
    expect(names).toHaveLength(1);
    expect(names[0]).toMatchObject({ name: 'rua.readysetmail.com', failed: 4, failed_not_yours: 4, failed_service: 0, fix: null, look: null });
    // Analytics: outside mail, not High impact, nothing to do
    expect(analytics.fixes.map((f: any) => f.kind)).toEqual(['outside-mail', 'outside-mail']);
    expect(analytics.fixes.map((f: any) => f.severity)).toEqual(['low', 'low']);
    expect(analytics.fixes.map((f: any) => f.title.replace(/: \d.*$/, ''))).toEqual(['Mail from outside, rejected by your policy', 'Mail from outside, sent as rua.readysetmail.com']);
    expect(analytics.fixes[0].steps[0]).toMatch(/^Nothing to fix/);
  });
});

describe('case 2: one real service sends as the domain without being set up for it', () => {
  it('every surface says one thing to look at, none says "Nothing to fix" or "to fix"', async () => {
    const { names, analytics, agent, summary } = await world([pass(90), service(10)]);
    expect(summary).toMatchObject({ failed_not_yours: 0, failed_service: 10, failed_service_names: ['rua.readysetmail.com'] });
    // next step: not the "done" step, not a note; the thing to look at
    expect(agent.steps.map((s: any) => s.key)).not.toContain('done');
    expect(agent.next_step).toMatchObject({ key: 'service-not-set-up', status: 'improve', do: 'Check the service sending as rua.readysetmail.com that is not set up for it' });
    expect(agent.next_step.why).toContain('a service sending as rua.readysetmail.com that is not set up for it: if it is yours, set up its custom return-path and DKIM for rua.readysetmail.com; if not, nothing to do');
    expect(sentences(agent.steps)).not.toMatch(/Nothing to fix|Nothing to do|likely mail pretending/);
    // names panel: "to look at", with the service sentence
    expect(names[0]).toMatchObject({ name: 'rua.readysetmail.com', failed_service: 10, fix: null });
    expect(names[0].look).toBe('A service sending as rua.readysetmail.com that is not set up for it: if it is yours, set up its custom return-path and DKIM for rua.readysetmail.com; if not, nothing to do (10 messages).');
    // Analytics: one thing to look at, medium, never "likely spoofing"
    expect(analytics.fixes).toHaveLength(1);
    expect(analytics.fixes[0]).toMatchObject({ kind: 'investigate-sender', severity: 'medium' });
    expect(analytics.fixes[0].detail).toContain('A service sending as rua.readysetmail.com that is not set up for it');
    expect(analytics.fixes[0].detail + analytics.fixes[0].steps.join(' ')).not.toMatch(/spoof|pretending/);
  });
});

describe('case 3: the owner\'s case, a spoofer and a service not set up for the domain', () => {
  it('the three places and the agent agree: one thing to look at, the spoofer is nothing to fix and not ranked above it', async () => {
    const { names, analytics, agent, summary } = await world([pass(90), spoofer(6), service(2)]);
    expect(summary).toMatchObject({ failed_not_yours: 6, failed_service: 2 });
    // next step
    expect(agent.next_step).toMatchObject({ key: 'service-not-set-up', status: 'improve', do: 'Check the service sending as rua.readysetmail.com that is not set up for it' });
    expect(agent.next_step.why).toContain('Of the 8 messages that failed, 6 came from servers that are not a known sending service');
    expect(agent.next_step.why).toContain('which needs no fix, and 2 from a service sending as rua.readysetmail.com that is not set up for it');
    expect(agent.steps.map((s: any) => s.key)).not.toContain('done');
    expect(sentences(agent.steps)).not.toMatch(/Nothing to do|Nothing to fix/);
    // names panel: the subdomain is one to look at; no name is "to fix"
    expect(names.filter((n) => n.fix)).toEqual([]);
    expect(names.find((n) => n.name === 'rua.readysetmail.com')).toMatchObject({ failed_service: 2, look: expect.stringContaining('A service sending as rua.readysetmail.com that is not set up for it') });
    // Analytics: the service is the one thing to look at (medium), the spoofer is outside mail ranked below it, nothing High
    expect(analytics.fixes.map((f: any) => f.kind)).toEqual(['investigate-sender', 'outside-mail']);
    expect(analytics.fixes.map((f: any) => f.severity)).not.toContain('high');
    expect(analytics.fixes[1].title).toMatch(/^Mail from outside, rejected by your policy/);
  });

  it('an owner\'s failing source stays "yours": SPF or DKIM passed for a name of the domain (strict alignment on the receiver) is "Fix the senders" and a name to fix', async () => {
    const own: Row = { from: 'rua.readysetmail.com', spf: 'mail.readysetmail.com', dkim: 'x.example', spfAligned: false, dkimAligned: false, n: 10 };
    const { names, agent, summary } = await world([pass(90), own]);
    expect(summary).toMatchObject({ failed_not_yours: 0, failed_service: 0 });
    expect(agent.next_step).toMatchObject({ key: 'senders', do: 'Fix the senders that fail DMARC' });
    expect(names.find((n) => n.name === 'rua.readysetmail.com')!.fix).toContain('10 messages sent as rua.readysetmail.com failed DMARC');
  });
});
