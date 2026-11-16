// B7 (audit): a subdomain added as its own domain takes over its own reports at once (the intake files a report about it under its proven
// row), but its page said "reports not connected". The state must match what the intake does (src/email/dmarc-report.ts gate,
// packages/db/src/queries/intake.ts connectedForReport): reports that name it as their policy domain arrive through the connected parent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { FIXED, hostedOwner, quietConsole, reportXml } from './world';

beforeEach(() => { resetSchemaReadyCache(); quietConsole(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const row = (n: number) => ({ from: 'app.readysetmail.com', spf: 'cf-bounce.app.readysetmail.com', dkim: 'app.readysetmail.com', spfAligned: true, dkimAligned: true, n });

describe('B7: the reports state of a subdomain added under a connected parent', () => {
  it('the intake files its report under the subdomain, and the page says reports arrive through the parent (not "not connected")', async () => {
    const w = await hostedOwner();
    const add = await w.api('POST', '/api/domains', { domain: 'app.readysetmail.com' });
    expect(add.status).toBe(201);
    const id = w.rows("SELECT id FROM domains WHERE domain = 'app.readysetmail.com'")[0].id;
    expect(w.rows('SELECT rua_address, reports_connected_at FROM domains WHERE id = ?', id)).toEqual([{ rua_address: '', reports_connected_at: null }]);

    // what the intake does: the next report about app. is filed under the app. row
    expect((await w.send(reportXml('app.readysetmail.com', 'r-app-1', [row(7)]))).rejected).toEqual([]);
    expect(w.filed()).toEqual([expect.objectContaining({ filed_under: 'app.readysetmail.com', total_count: 7 })]);

    // what the page says
    const s = await w.api('GET', `/api/domains/${id}/report-address`);
    expect(s.body).toMatchObject({ available: true, address: null, state: 'not_connected', via_parent: { domain: 'readysetmail.com' } });
  });

  it('no parent connection, no claim: a subdomain whose parent did not connect reports has no via_parent', async () => {
    const w = await hostedOwner();
    await w.api('POST', '/api/domains', { domain: 'app.readysetmail.com' });
    const id = w.rows("SELECT id FROM domains WHERE domain = 'app.readysetmail.com'")[0].id;
    w.db.sqlite.prepare("UPDATE domains SET rua_address = '', reports_connected_at = NULL WHERE id = 1").run();
    const s = await w.api('GET', `/api/domains/${id}/report-address`);
    expect(s.body).toMatchObject({ address: null, state: 'not_connected', via_parent: null });
  });

  it('a row that connected reports itself has an address and no via_parent', async () => {
    const w = await hostedOwner();
    await w.api('POST', '/api/domains', { domain: 'app.readysetmail.com' });
    const id = w.rows("SELECT id FROM domains WHERE domain = 'app.readysetmail.com'")[0].id;
    const c = await w.api('POST', `/api/domains/${id}/report-address`, {});
    expect(c.body).toMatchObject({ address: FIXED, via_parent: null });
  });

  it('the domain list answers what the intake does: the row carries the connection its reports arrive through, so no page says "not connected"', async () => {
    const w = await hostedOwner();
    await w.api('POST', '/api/domains', { domain: 'app.readysetmail.com' });
    const rows = (await w.api('GET', '/api/domains')).body.domains as Array<{ domain: string; rua_address: string; reports_via?: { domain: string } }>;
    expect(rows.find((r) => r.domain === 'app.readysetmail.com')).toMatchObject({ rua_address: FIXED, reports_via: { domain: 'readysetmail.com' } });
    expect(rows.find((r) => r.domain === 'readysetmail.com')).toMatchObject({ rua_address: FIXED });
    expect(rows.find((r) => r.domain === 'readysetmail.com')!.reports_via).toBeUndefined();
    // the stored row is unchanged
    expect(w.rows("SELECT rua_address FROM domains WHERE domain = 'app.readysetmail.com'")).toEqual([{ rua_address: '' }]);
  });

  it('a subdomain whose parent did not connect keeps an empty address in the list', async () => {
    const w = await hostedOwner();
    await w.api('POST', '/api/domains', { domain: 'app.readysetmail.com' });
    w.db.sqlite.prepare("UPDATE domains SET rua_address = '', reports_connected_at = NULL WHERE id = 1").run();
    const rows = (await w.api('GET', '/api/domains')).body.domains as Array<{ domain: string; rua_address: string }>;
    expect(rows.find((r) => r.domain === 'app.readysetmail.com')!.rua_address).toBe('');
  });

  it('its DMARC record is compared with the connection its reports arrive through: it "sends reports here" (live and stored)', async () => {
    const w = await hostedOwner();
    await w.api('POST', '/api/domains', { domain: 'app.readysetmail.com' });
    const id = w.rows("SELECT id FROM domains WHERE domain = 'app.readysetmail.com'")[0].id;
    // app.readysetmail.com publishes its own record naming rua@rua.readysetmail.com (the owner's real DNS)
    const ob = await w.api('GET', `/api/domains/${id}/onboarding-status`);
    expect(ob.body.dmarc).toMatchObject({ found: true, has_our_rua: true });
    const live = await w.api('GET', `/api/domains/${id}/dns-check`);
    expect(live.body).toMatchObject({ found: true, has_rua: true });
    const sum = await w.api('GET', `/api/domains/${id}/check-summary`);
    expect(sum.body).toMatchObject({ dmarc_policy: 'reject', dmarc_rua: 1 });
  });
});
