// PR 181 round 3, item 3: Anomalies opened with "No source failed DMARC" above rows of "verdict not recorded" while the report page said "Failed 15".
// Hosted keeps no raw XML, so the rows can stay unrecorded for good: both pages lead with the same count, from the same server function.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { hostedOwner, quietConsole, reportXml, type Row } from './world';

beforeEach(() => { resetSchemaReadyCache(); quietConsole(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const RSM = 'readysetmail.com';
const row = (n: number, spf: boolean, dkim: boolean): Row => ({ from: RSM, spf: RSM, dkim: RSM, spfAligned: spf, dkimAligned: dkim, n });

describe('reports with records that have no recorded verdict', () => {
  it('the anomalies and the day\'s report answer with the same count of reports', async () => {
    const w = await hostedOwner();
    await w.send(reportXml(RSM, 'r-old', [row(15, false, false), row(10, true, true)]));
    await w.send(reportXml(RSM, 'r-new', [row(5, true, true)]));
    const none = (await w.api('GET', '/api/domains/1/anomalies?days=30')).body;
    expect(none.unrecorded_reports).toBe(0);
    // the old report: its records were stored before 0022 kept the verdict (and nothing can recover it)
    w.db.sqlite.prepare("UPDATE report_records SET spf_aligned = NULL, dkim_aligned = NULL WHERE report_id = (SELECT id FROM aggregate_reports WHERE report_id LIKE '%r-old')").run();
    const an = (await w.api('GET', '/api/domains/1/anomalies?days=30')).body;
    expect(an.unrecorded_reports).toBe(1);
    expect(an.anomalies.every((a: any) => a.verdict === 'not-recorded')).toBe(true);
    const day = new Date().toISOString().slice(0, 10);
    const dayBegin = w.rows("SELECT date(datetime(date_begin, 'unixepoch')) AS d FROM aggregate_reports LIMIT 1")[0].d as string;
    const rep = (await w.api('GET', `/api/domains/1/reports?date=${dayBegin}`)).body;
    expect(day).toBeTruthy();
    expect(rep.unrecorded_reports).toBe(1);
    // the report's own totals still count the 15 failures the reporter saw: the page must not call them recorded
    expect(rep.summary.failed).toBe(15);
  });
});
