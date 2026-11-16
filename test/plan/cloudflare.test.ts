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

describe('"Also in your Cloudflare account" is shown once', () => {
  it('the suggestions say whether they were dismissed, and a dismissal sticks for the workspace', async () => {
    const s = await setup(['a.com', 'b.org']);
    await s.imp({ preferred_domain: 'a.com' });
    const before = await json(await s.w.api(s.token, 'GET', '/api/cloudflare/suggestions'));
    expect(before.dismissed).toBe(false);
    expect(before.suggestions.map((z: any) => z.name)).toEqual(['b.org']);
    expect((await s.w.api(s.token, 'POST', '/api/cloudflare/suggestions/dismiss', {})).status).toBe(200);
    expect((await json(await s.w.api(s.token, 'GET', '/api/cloudflare/suggestions'))).dismissed).toBe(true);
  });
});

describe('an account with many zones (an agency)', () => {
  const many = Array.from({ length: 50 }, (_, i) => `zone-${String(i).padStart(2, '0')}.com`);
  it('connecting and importing with 50 zones works (D1 takes at most 100 bound values in a statement), and every other zone is offered', async () => {
    const s = await setup(many);
    const res = await s.imp({ preferred_domain: 'zone-07.com' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.imported.map((i: any) => i.domain)).toEqual(['zone-07.com']);
    expect(body.other_zones).toHaveLength(49);
    const sug = await json(await s.w.api(s.token, 'GET', '/api/cloudflare/suggestions'));
    expect(sug.suggestions).toHaveLength(49);
    expect(s.w.rows('SELECT COUNT(*) AS n FROM cloudflare_connection_zones')[0].n).toBe(50);
  });
  it('with HOSTED_PLAN off the same account imports whole', async () => {
    const s = await setup(many.slice(0, 30), {});
    const res = await s.imp({});
    expect(res.status).toBe(200); // not a 500 "too many SQL variables"
  });
});

describe('"Also in your Cloudflare account" lists only what would cost something', () => {
  it('a zone whose domain is already held, or that is a subdomain of a held one, or the parent of a held one, is not offered; a removed zone is, marked', async () => {
    const s = await setup(['held.com', 'sub.held.com', 'other.org', 'mail.other.org', 'new.net']);
    await s.imp({ preferred_domain: 'held.com' });
    const sug = await json(await s.w.api(s.token, 'GET', '/api/cloudflare/suggestions'));
    // held.com is the unit held; a zone inside it is the same unit; the unrelated ones are what "also" means
    expect(sug.suggestions.map((z: any) => z.name)).toEqual(['new.net', 'other.org']); // other.org and mail.other.org are ONE unit: offered once, by its apex
  });
  it('the parent zone of a held subdomain is the same unit: not offered', async () => {
    const s = await setup(['parent.com', 'other.org']);
    s.w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES ('mail.parent.com', 'rua@reports.mail.parent.com', ?, 'txt')").run(s.ws);
    const sug = await json(await s.w.api(s.token, 'GET', '/api/cloudflare/suggestions'));
    expect(sug.suggestions.map((z: any) => z.name)).toEqual(['other.org']);
  });
  it('a domain evicted from this workspace holds no unit: its zone is offered again like any other', async () => {
    const s = await setup(['gone.com', 'other.org']);
    s.w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via, evicted_at) VALUES ('gone.com', 'rua@reports.gone.com', ?, 'txt', unixepoch())").run(s.ws);
    const sug = await json(await s.w.api(s.token, 'GET', '/api/cloudflare/suggestions'));
    expect(sug.suggestions.map((z: any) => z.name)).toEqual(['gone.com', 'other.org']);
  });
  it('with HOSTED_PLAN off the list is what it was: the parent zone of a held subdomain is still suggested', async () => {
    const s = await setup(['parent.com', 'other.org'], {});
    s.w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via) VALUES ('mail.parent.com', 'rua@reports.mail.parent.com', ?, 'txt')").run(s.ws);
    const sug = await json(await s.w.api(s.token, 'GET', '/api/cloudflare/suggestions'));
    expect(sug.suggestions.map((z: any) => z.name)).toEqual(['other.org', 'parent.com']);
  });
});
