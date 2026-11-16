// Connect Cloudflare under the plan: the domain the person typed (or the zone of their sign-up email) is imported with no question, the other zones are
// returned as `other_zones` (never added here: each is a paid domain, confirmed elsewhere), and with no match there is one choice and nothing else.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signupVerified } from '../auth/helpers';
import { world } from '../connections/world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = async (r: Response) => await r.json() as any;
const zid = (n: string) => Buffer.from(n).toString('hex').padEnd(32, '0').slice(0, 32);

async function setup(zones: string[], extraEnv: Record<string, unknown> = { HOSTED_PLAN: 'free_one_domain' }, email = 'c@example.com') {
  const w = await world(extraEnv);
  const token = await signupVerified(w.env, email);
  const ws = w.rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0].workspace_id as string;
  for (const k of Object.keys(w.cf.zones)) delete w.cf.zones[k];
  for (const name of zones) w.cf.zones[name] = { id: zid(name), cfAccountId: 'acct-1', cfAccountName: 'Example Co' };
  w.cf.accounts = [{ id: 'acct-1', name: 'Example Co' }];
  const id = (await w.addToken(token, 'secret-token-aaaaaaaaaaaa-1')).id;
  const imp = (body?: unknown) => w.api(token, 'POST', `/api/cloudflare/connections/${id}/import`, body);
  const domains = () => w.rows('SELECT domain FROM domains WHERE workspace_id = ? ORDER BY domain', ws).map((r) => r.domain as string);
  return { w, token, ws, id, imp, domains };
}

describe('Connect Cloudflare with several zones', () => {
  it('the domain the person typed is imported without a question; the others are other_zones, none of them added', async () => {
    const s = await setup(['typed.com', 'other-1.org', 'other-2.net']);
    const res = await json(await s.imp({ preferred_domain: 'Typed.com' }));
    expect(res.imported.map((i: any) => i.domain)).toEqual(['typed.com']);
    expect(res.other_zones.map((z: any) => z.name).sort()).toEqual(['other-1.org', 'other-2.net']);
    expect(res.needs_selection).toBeUndefined();
    expect(s.domains()).toEqual(['typed.com']);
  });

  it('a typed subdomain picks the zone it belongs to', async () => {
    const s = await setup(['typed.com', 'other.org']);
    const res = await json(await s.imp({ preferred_domain: 'mail.typed.com' }));
    expect(res.imported.map((i: any) => i.domain)).toEqual(['typed.com']);
  });

  it('with none typed, the zone of the sign-up email\'s domain is the one', async () => {
    const s = await setup(['example.com', 'other.org'], { HOSTED_PLAN: 'free_one_domain' }, 'person@example.com');
    const res = await json(await s.imp({}));
    expect(res.imported.map((i: any) => i.domain)).toEqual(['example.com']);
    expect(res.other_zones.map((z: any) => z.name)).toEqual(['other.org']);
  });

  it('when neither matches: the existing single choice (room 1), nothing imported, and the choice is then made with one zone id', async () => {
    const s = await setup(['a.com', 'b.org', 'c.net']);
    const res = await json(await s.imp({ preferred_domain: 'nothing.example' }));
    expect(res.imported).toEqual([]);
    expect(res.needs_selection).toMatchObject({ room: 1, cap: 1 });
    expect(res.needs_selection.zones.map((z: any) => z.name).sort()).toEqual(['a.com', 'b.org', 'c.net']);
    expect(s.domains()).toEqual([]);
    const one = await json(await s.imp({ zone_ids: [zid('b.org')] }));
    expect(one.imported.map((i: any) => i.domain)).toEqual(['b.org']);
    // two at once is a plan question, not a free import
    const two = await s.imp({ zone_ids: [zid('a.com'), zid('c.net')] });
    expect(two.status).toBe(402);
    expect((await json(two)).code).toBe('plan_required');
    expect(s.domains()).toEqual(['b.org']);
  });

  it('a person who holds their free domain already gets every zone back as other_zones and nothing is added', async () => {
    const s = await setup(['a.com', 'b.org']);
    await s.imp({ preferred_domain: 'a.com' });
    const again = await json(await s.imp({ preferred_domain: 'b.org' }));
    expect(again.imported).toEqual([]);
    expect(again.other_zones.map((z: any) => z.name)).toEqual(['b.org']);
    expect(s.domains()).toEqual(['a.com']);
  });

  it('with HOSTED_PLAN off the import is exactly what it was (everything that fits is added)', async () => {
    const s = await setup(['a.com', 'b.org', 'c.net'], {});
    const res = await json(await s.imp({ preferred_domain: 'a.com' }));
    expect(res.imported.map((i: any) => i.domain).sort()).toEqual(['a.com', 'b.org', 'c.net']);
    expect(res.other_zones).toBeUndefined();
  });
});
