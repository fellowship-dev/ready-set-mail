// A domain typed in the setup wizard (POST /api/settings/base-domain) and proven by its TXT record: one Domain Added for the claim, however
// many times the same claim is answered, and nothing more when it is proven (docs/analytics.md, "Domain Added").
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SECRETS, settle, world } from './walk';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const DOMAIN = 'plain-walk.net';

describe('the wizard\'s base-domain route and Domain Added', () => {
  it('a pending claim counts one Domain Added (typed, needs proof, no path); the same claim again counts nothing; the TXT proof is Ownership Verified (manual) and no second Domain Added', async () => {
    const w = world();
    const token = await w.signUp(SECRETS.emails[4]!);
    const mine = () => w.events().filter((e) => ['Domain Added', 'Ownership Verified'].includes(e.event));

    const first = await w.api(token, 'POST', '/api/settings/base-domain', { domain: DOMAIN });
    expect(first.status).toBe(202);
    const claim = (await w.json(first)).claim;
    await settle();
    expect(mine().map((e) => e.event)).toEqual(['Domain Added']);
    expect(mine()[0]!.properties).toMatchObject({ source: 'typed', needs_proof: true, added: '1' });
    expect(mine()[0]!.properties).not.toHaveProperty('path');

    // Continue pressed again: admitDomain returns the same claim, which is not counted again.
    const again = await w.api(token, 'POST', '/api/settings/base-domain', { domain: DOMAIN });
    expect((await w.json(again)).claim.id).toBe(claim.id);
    await settle();
    expect(mine().map((e) => e.event)).toEqual(['Domain Added']);

    // The TXT record is published and the claim is verified.
    w.cf.doh[claim.txt_name] = [claim.txt_value];
    expect((await w.api(token, 'POST', `/api/domains/claims/${claim.id}/verify`)).ok).toBe(true);
    await settle();
    expect(mine().map((e) => e.event)).toEqual(['Domain Added', 'Ownership Verified']);
    expect(mine()[1]!.properties).toMatchObject({ path: 'manual', method: 'txt' });
  });

  it('typed at the wizard, then proven by its Cloudflare zone through the same route: Ownership Verified (cloudflare) only, still one Domain Added', async () => {
    const w = world();
    const domain = 'acme-walk.com';
    const token = await w.signUp(SECRETS.emails[3]!);
    expect((await w.api(token, 'POST', '/api/settings/base-domain', { domain })).status).toBe(202);
    const c = await w.api(token, 'POST', '/api/cloudflare/connections', { token: 'walk-pasted-token-0000000000000000' });
    const id = (await w.json(c)).connection.id as string;
    const zones = (await w.json(await w.api(token, 'GET', `/api/cloudflare/connections/${id}/zones`))).zones as { id: string; name: string }[];
    await w.api(token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: zones.filter((z) => z.name === domain).map((z) => z.id) });
    const after = await w.api(token, 'POST', '/api/settings/base-domain', { domain });
    await settle();
    expect(w.rows('SELECT verified_via FROM domains WHERE domain = ?', domain)[0]?.verified_via, `status ${after.status}`).toBe('cloudflare');
    expect(w.events().filter((e) => e.event === 'Domain Added')).toHaveLength(1);
    expect(w.events().filter((e) => e.event === 'Ownership Verified').map((e) => e.properties.path)).toEqual(['cloudflare']);
  });

  it('the same claim typed through POST /api/domains and then the wizard is one Domain Added', async () => {
    const w = world();
    const token = await w.signUp(SECRETS.emails[4]!);
    expect((await w.api(token, 'POST', '/api/domains', { domain: DOMAIN })).status).toBe(202);
    expect((await w.api(token, 'POST', '/api/settings/base-domain', { domain: DOMAIN })).status).toBe(202);
    expect((await w.api(token, 'POST', '/api/domains', { domain: DOMAIN })).status).toBe(202);
    await settle();
    expect(w.events().filter((e) => e.event === 'Domain Added')).toHaveLength(1);
  });
});
