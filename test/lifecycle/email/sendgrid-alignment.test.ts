// The earlier reviewer's case, through the stored rows: a source that signs DKIM for sendgrid.net is a failing source only when the receiver's own
// verdict says the message failed DMARC (`dmarcVerdict`, the one rule). A message signed for sendgrid.net AND for the domain itself (aligned) passes.
import { describe, expect, it } from 'vitest';
import { sourceStats, failingSources, tipFixSources } from '../../../src/lifecycle/email/analysis';
import { lifecycleWorld, MON_16_NOV, DAY } from './world';

const D = 'brightwave-mail.com';
const sendgrid = { ip: '198.51.100.7', count: 20, spf: ['pass', 'sendgrid.net'] as [string, string], dkim: ['pass', 'sendgrid.net'] as [string, string], org: 'SendGrid' };

async function reported(records: Array<typeof sendgrid & { spfAligned: number; dkimAligned: number }>, passed: number) {
  const w = await lifecycleWorld();
  w.clock.now = MON_16_NOV;
  const domainId = w.addDomain({ domain: D });
  const reportId = w.addReport({ domain: D, day: MON_16_NOV - DAY - 3600, storedAt: MON_16_NOV, passed, records });
  const rows = await w.tenant().scope.lifecycleEmail.reports.reportSources(reportId);
  return { w, domainId, reportId, rows, stats: sourceStats(rows, records.reduce((n, r) => n + r.count, 0) - passed) };
}

describe('a row signed d=sendgrid.net and d=<the domain> (aligned) that passes DMARC', () => {
  it('counts as passed: no failing source, no tip, and the first report says every message passed', async () => {
    const { w, domainId, reportId, rows, stats } = await reported([{ ...sendgrid, spfAligned: 0, dkimAligned: 1 }], 20);
    expect(rows[0]).toMatchObject({ dkim_domain: 'sendgrid.net', spf_aligned: 0, dkim_aligned: 1 });
    expect(stats[0]).toMatchObject({ messages: 20, failing: 0, other: null, mine: null });
    expect(failingSources(stats)).toEqual([]);
    expect(tipFixSources(stats)).toEqual([]);
    await w.realtimeFirstReport(domainId, reportId);
    const mail = w.mailer.sent.filter((m) => m.subject.startsWith('First DMARC report'));
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe(`First DMARC report for ${D}: 20 messages, all passed`);
    expect(mail[0].text).toContain('Every message passed DMARC');
  });
});

describe('a row signed only d=sendgrid.net with SPF passing for sendgrid.net only (not aligned)', () => {
  it('counts as failed and is attributed to SendGrid, which the owner may use: summary and tip see it', async () => {
    const { w, domainId, reportId, rows, stats } = await reported([{ ...sendgrid, spfAligned: 0, dkimAligned: 0 }], 0);
    expect(rows[0]).toMatchObject({ spf_aligned: 0, dkim_aligned: 0 });
    expect(stats[0]).toMatchObject({ name: 'SendGrid', messages: 20, failing: 20, other: { by: 'DKIM', domain: 'sendgrid.net' }, mine: 'SendGrid' });
    expect(failingSources(stats).map((s) => s.name)).toEqual(['SendGrid']);
    expect(tipFixSources(stats).map((s) => s.name)).toEqual(['SendGrid']);
    await w.realtimeFirstReport(domainId, reportId);
    const mail = w.mailer.sent.filter((m) => m.subject.startsWith('First DMARC report'));
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe(`First DMARC report for ${D}: 20 messages, 0 passed`);
    expect(JSON.stringify(mail[0])).toContain('SendGrid');
  });
});
