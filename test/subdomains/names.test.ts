// "Names seen sending as this domain": the subdomains in a domain's reports, inside the domain (not as sibling rows), each with its volume, what
// the receivers decided, the policy that applies to the NAME and where it comes from (RFC 9989 section 4.10.1), and the one thing to fix.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { MAX_DNS, hostedOwner, quietConsole, reportXml, type Zone } from './world';

beforeEach(() => { resetSchemaReadyCache(); quietConsole(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const parentReport = () => reportXml('readysetmail.com', 'r-parent', [
  { from: 'readysetmail.com', spf: 'readysetmail.com', dkim: 'readysetmail.com', spfAligned: true, dkimAligned: true, n: 10 },
  { from: 'app.readysetmail.com', spf: 'cf-bounce.app.readysetmail.com', dkim: 'app.readysetmail.com', spfAligned: true, dkimAligned: true, n: 40 },
  { from: 'rua.readysetmail.com', spf: 'rua.readysetmail.com', dkim: 'rua.readysetmail.com', spfAligned: false, dkimAligned: false, n: 2 },
]);

describe('GET /api/domains/:id/names', () => {
  it('lists each subdomain inside the domain with its policy and where it comes from, and never the domain itself', async () => {
    const w = await hostedOwner();
    await w.send(parentReport());
    const r = await w.api('GET', '/api/domains/1/names?days=90');
    expect(r.status).toBe(200);
    const names = r.body.names as Array<{ name: string; roles: string[]; messages: number; passed: number; failed: number; effective: any; source: string | null; fix: string | null }>;
    expect(names.map((n) => n.name)).toEqual(['app.readysetmail.com', 'cf-bounce.app.readysetmail.com', 'rua.readysetmail.com']);

    const app = names[0]!;
    expect(app).toMatchObject({ roles: ['from'], messages: 40, passed: 40, failed: 0, fix: null });
    expect(app.effective).toMatchObject({ policy: 'reject', tag: 'p', source: 'own', at: 'app.readysetmail.com' });
    expect(app.source).toContain('app.readysetmail.com publishes its own DMARC record, which sets p=reject');

    const bounce = names[1]!;
    expect(bounce).toMatchObject({ roles: ['return-path'], messages: 40, effective: null, fix: null });

    const rua = names[2]!;
    expect(rua).toMatchObject({ roles: ['from', 'return-path'], messages: 2, passed: 0, failed: 2 });
    expect(rua.effective).toMatchObject({ policy: 'reject', tag: 'p', source: 'organizational', at: 'readysetmail.com' });
    expect(rua.fix).toContain('2 messages sent as rua.readysetmail.com failed DMARC because neither SPF nor DKIM aligned with it');
  });

  it('a name under a parent with sp=none is under none, said with the tag and the record, and the fix says so', async () => {
    const zone: Zone = { ...MAX_DNS, '_dmarc.readysetmail.com': { TXT: ['v=DMARC1; p=reject; sp=none; rua=mailto:rua@rua.readysetmail.com;'] } };
    delete zone['_dmarc.app.readysetmail.com'];
    const w = await hostedOwner(zone);
    await w.send(parentReport());
    const names = (await w.api('GET', '/api/domains/1/names?days=90')).body.names as Array<{ name: string; effective: any; source: string; fix: string | null }>;
    const app = names.find((n) => n.name === 'app.readysetmail.com')!;
    expect(app.effective).toMatchObject({ policy: 'none', tag: 'sp', source: 'organizational', at: 'readysetmail.com' });
    expect(app.source).toContain("sp=none on readysetmail.com's record applies to it");
    expect(app.fix).toContain('Mail that fails DMARC from app.readysetmail.com is still delivered');
  });

  it('is a 404 for a domain that is not in this workspace', async () => {
    const w = await hostedOwner();
    const r = await w.api('GET', '/api/domains/999/names');
    expect(r.status).toBe(404);
  });

  it('is empty when the reports name no subdomain', async () => {
    const w = await hostedOwner();
    await w.send(reportXml('readysetmail.com', 'r-only', [{ from: 'readysetmail.com', spf: 'readysetmail.com', dkim: 'readysetmail.com', spfAligned: true, dkimAligned: true, n: 5 }]));
    expect((await w.api('GET', '/api/domains/1/names')).body.names).toEqual([]);
  });
});
