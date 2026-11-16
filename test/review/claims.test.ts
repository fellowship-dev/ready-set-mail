import { describe, it, afterEach, vi } from 'vitest';
import { planWorld, json, rows } from '../plan/world';
vi.setConfig({ testTimeout: 120_000 });
afterEach(() => vi.unstubAllGlobals());
describe('K claims under the plan', () => {
  it('free user: claims without a card, counting, removal', async () => {
    const w = await planWorld();
    const out: Record<string, unknown> = {};
    const c1 = await w.api(w.owner, 'POST', '/api/domains', { domain: 'first.example.com' });
    const c2 = await w.api(w.owner, 'POST', '/api/domains', { domain: 'second.example.org' });
    const c3 = await w.api(w.owner, 'POST', '/api/domains', { domain: 'third.example.net' });
    out.claimsNoCardNoDomain = [c1.status, c2.status, c3.status, (await json(c2.clone())).pending ?? (await json(c2.clone())).code];
    out.claimRows = rows(w.db, 'SELECT domain, status FROM domain_claims').map((r) => `${r.domain}:${r.status}`);
    let v = (await json(await w.api(w.owner, 'GET', '/api/billing'))).plan;
    out.unitsWith3Claims = [v.units, v.billable];
    // prove the second claim first: it takes the free slot
    const cl2 = rows(w.db, "SELECT * FROM domain_claims WHERE domain = 'second.example.org'")[0];
    w.prove('second.example.org', { txt_name: `_readysetmail.second.example.org`, txt_value: `readysetmail-verify=${cl2.token}` });
    out.verifySecond = (await w.api(w.owner, 'POST', `/api/domains/claims/${cl2.id}/verify`, {})).status;
    const cl1 = rows(w.db, "SELECT * FROM domain_claims WHERE domain = 'first.example.com'")[0];
    w.prove('first.example.com', { txt_name: `_readysetmail.first.example.com`, txt_value: `readysetmail-verify=${cl1.token}` });
    const vf = await w.api(w.owner, 'POST', `/api/domains/claims/${cl1.id}/verify`, {});
    out.verifyFirstAfterFreeUsed = [vf.status, (await json(vf)).code];
    out.claimsAfter = rows(w.db, 'SELECT domain, status, settled_at FROM domain_claims').map((r) => `${r.domain}:${r.status}:${r.settled_at ? 'settled' : 'open'}`);
    // another person, with a free domain, makes a claim while an API key / agent: refused at claim time?
    const cl3 = rows(w.db, "SELECT * FROM domain_claims WHERE domain = 'third.example.net'")[0];
    const del = await w.api(w.owner, 'DELETE', `/api/domains/claims/${cl3.id}`);
    out.deleteClaim = del.status;
    // a stuck claim when no domain exists: can the person remove it and add another?
    const w2 = await planWorld();
    const s1 = await w2.api(w2.owner, 'POST', '/api/domains', { domain: 'typo.exmaple.com' });
    const sc = rows(w2.db, 'SELECT * FROM domain_claims')[0];
    const sdel = await w2.api(w2.owner, 'DELETE', `/api/domains/claims/${sc.id}`);
    const s2 = await w2.addFree(w2.owner, 'right.example.com');
    out.stuck = [s1.status, sdel.status, s2.status];
    // claims count: how many open claims can a free user hold?
    let n = 0; let last = 0;
    for (let i = 0; i < 30; i++) { const r = await w2.api(w2.owner, 'POST', '/api/domains', { domain: `c${i}.spam-co${i}.com` }); last = r.status; if (r.status < 300) n++; else break; }
    out.openClaimsAllowed = [n, last];
    console.info('K', JSON.stringify(out));
  });
});
