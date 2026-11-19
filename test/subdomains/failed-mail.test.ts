// B1 (audit, 2026-11-15): a message that fails DMARC because SPF and DKIM passed for ANOTHER domain (alignment failure) was counted as
// failed but never listed. Every failed message must be attributable: which identifier failed to align with the From domain, and why.
// RFC 9989 section 3.2.10.1-2 (relaxed and strict alignment); RFC 9990 section 3.1.1.10-13 (the identifiers a record carries).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { hostedOwner, quietConsole, reportXml } from './world';

beforeEach(() => { resetSchemaReadyCache(); quietConsole(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('B1: failed mail whose raw SPF and DKIM pass is listed, with the identifier that did not align', () => {
  it('the audit example: 9 messages fail DMARC, raw SPF and DKIM pass for the sending service: stats say 9 failed, the failing list names them', async () => {
    const w = await hostedOwner();
    await w.send(reportXml('readysetmail.com', 'r-esp', [{ from: 'readysetmail.com', spf: 'bounces.esp.example', dkim: 'esp.example', spfAligned: false, dkimAligned: false, n: 9 }]));
    const stats = await w.api('GET', '/api/domains/1/stats?days=3650');
    expect(stats.body.stats.reduce((n: number, d: { failed: number }) => n + d.failed, 0)).toBe(9);

    const an = await w.api('GET', '/api/domains/1/anomalies?days=3650');
    expect(an.body.anomalies).toHaveLength(1);
    expect(an.body.anomalies[0]).toMatchObject({ header_from: 'readysetmail.com', spf_domain: 'bounces.esp.example', dkim_domain: 'esp.example', total: 9, spf_pass: 1, dkim_pass: 1, dmarc_fail: 1, spf_aligned: 0, dkim_aligned: 0 });

    const ex = await w.api('GET', '/api/domains/1/explore?days=3650');
    expect(ex.body.sources.filter((s: { dmarc_fail: number }) => s.dmarc_fail === 1)).toHaveLength(1);
  });

  it('the top failing sources on the domain page include it', async () => {
    const w = await hostedOwner();
    await w.send(reportXml('readysetmail.com', 'r-esp', [{ from: 'readysetmail.com', spf: 'bounces.esp.example', dkim: 'esp.example', spfAligned: false, dkimAligned: false, n: 9 }]));
    const { forWorkspace } = await import('@ready-set-mail/db');
    const top = await forWorkspace(w.env.DB, w.ws).reports.topFailingSources(1, 0);
    expect(top.map((s: { total: number }) => s.total)).toEqual([9]);
  });

  it('the sources route lists the failed sources and counts the ones that passed on one check or have no recorded verdict', async () => {
    const w = await hostedOwner();
    await w.send(reportXml('readysetmail.com', 'r-mix', [
      { from: 'readysetmail.com', spf: 'bounces.esp.example', dkim: 'esp.example', spfAligned: false, dkimAligned: false, n: 9 },
      { from: 'readysetmail.com', spf: 'readysetmail.com', dkim: 'esp.example', spfAligned: true, dkimAligned: false, n: 4 },
    ]));
    const res = await w.api('GET', '/api/domains/1/sources?days=3650');
    expect(res.body.sources.map((s: { total: number }) => s.total)).toEqual([9]);
    expect(res.body.one_check).toEqual({ sources: 1, messages: 4 });
    expect(res.body.not_recorded).toEqual({ sources: 0, messages: 0 });
  });

  it('strict alignment: the receiver says aspf=s, so the return-path subdomain does not align and the row says so', async () => {
    const w = await hostedOwner();
    // app. sends through cf-bounce.app.: relaxed alignment holds (same organizational domain); under aspf=s it fails, and DKIM is a provider's d=
    await w.send(reportXml('readysetmail.com', 'r-strict', [{ from: 'app.readysetmail.com', spf: 'cf-bounce.app.readysetmail.com', dkim: 'mailer.example', spfAligned: false, dkimAligned: false, n: 4 }], { aspf: 's' }));
    const an = await w.api('GET', '/api/domains/1/anomalies?days=3650');
    expect(an.body.anomalies).toHaveLength(1);
    expect(an.body.anomalies[0]).toMatchObject({ header_from: 'app.readysetmail.com', dmarc_fail: 1, aspf: 's', adkim: 'r' });
  });

  it('mail that passes DMARC through one identifier is not reported as a DMARC failure', async () => {
    const w = await hostedOwner();
    await w.send(reportXml('readysetmail.com', 'r-ok', [{ from: 'readysetmail.com', spf: 'readysetmail.com', dkim: 'readysetmail.com', spfAligned: true, dkimAligned: true, n: 12 }]));
    const an = await w.api('GET', '/api/domains/1/anomalies?days=3650');
    expect(an.body.anomalies).toEqual([]);
  });

  it('the receiver\'s verdict and modes are kept per record and per report (migration 0022)', async () => {
    const w = await hostedOwner();
    await w.send(reportXml('readysetmail.com', 'r-kept', [{ from: 'readysetmail.com', spf: 'readysetmail.com', dkim: 'esp.example', spfAligned: true, dkimAligned: false, n: 3 }], { aspf: 's', adkim: 'r' }));
    expect(w.rows('SELECT spf_aligned, dkim_aligned FROM report_records')).toEqual([{ spf_aligned: 1, dkim_aligned: 0 }]);
    expect(w.rows('SELECT aspf, adkim FROM aggregate_reports')).toEqual([{ aspf: 's', adkim: 'r' }]);
  });
});
