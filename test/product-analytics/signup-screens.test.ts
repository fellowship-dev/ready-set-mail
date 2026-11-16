// The new sign-up screens' analytics call sites (PR 177; docs/analytics.md "The new sign-up screens"): profile saved, resend, the S4 choice.
// Categories only, through the one analytics module; the free text the person typed never leaves the Worker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, ctx, lastCodeFor, pendingCookieOf, inviteAndAccept } from '../auth/helpers';
import { SECRETS, settle, world } from './walk';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
beforeEach(() => { vi.mocked(ctx.waitUntil).mockClear?.(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const EMAIL = SECRETS.emails[0]!;
const ABOUT = { name: 'Dana Whitfield', organization: 'Acme Walk Ltd', whose_email: 'clients', role: 'agency', heard_about: 'A friend at acme-walk.com told me about it' };
const post = (w: ReturnType<typeof world>, path: string, body: object, cookie?: string) => call(w.env, 'POST', path, { body, headers: cookie ? { cookie } : {} });

describe('S2: Signup Profile Saved', () => {
  it('counts the closed answers and whether "heard about" was filled, under the attempt\'s id; never a name, the organization or the text', async () => {
    const w = world();
    const s1 = await post(w, '/api/auth/signup', { email: EMAIL, password: SECRETS.password, src: 'checker', from_checker: true });
    const cookie = pendingCookieOf(s1);
    expect((await post(w, '/api/auth/signup/profile', ABOUT, cookie)).status).toBe(200);
    await settle();
    const started = w.events().find((e) => e.event === 'Signup Started')!;
    const saved = w.events().find((e) => e.event === 'Signup Profile Saved')!;
    expect(saved.distinct_id).toBe(started.distinct_id); // the attempt's one id
    expect(saved.properties).toMatchObject({ whose_email: 'clients', role: 'agency', heard_about_given: true });
    for (const r of w.sent) for (const s of ['Dana', 'Whitfield', 'Acme Walk', 'friend', 'acme-walk.com']) expect(r.body, s).not.toContain(s);
  });

  it('no role, no "heard about": role none, heard_about_given false', async () => {
    const w = world();
    const cookie = pendingCookieOf(await post(w, '/api/auth/signup', { email: EMAIL, password: SECRETS.password }));
    await post(w, '/api/auth/signup/profile', { name: 'Dana', organization: 'Acme', whose_email: 'company' }, cookie);
    await settle();
    expect(w.events().find((e) => e.event === 'Signup Profile Saved')!.properties).toMatchObject({ whose_email: 'company', role: 'none', heard_about_given: false });
  });

  it('a refused answer or an ended attempt counts nothing', async () => {
    const w = world();
    const cookie = pendingCookieOf(await post(w, '/api/auth/signup', { email: EMAIL, password: SECRETS.password }));
    expect((await post(w, '/api/auth/signup/profile', { name: '', organization: '', whose_email: 'nobody' }, cookie)).status).toBe(400);
    expect((await post(w, '/api/auth/signup/profile', ABOUT)).status).toBe(410);
    await settle();
    expect(w.events().filter((e) => e.event === 'Signup Profile Saved')).toEqual([]);
  });
});

describe('resend', () => {
  it('a resent code keeps the attempt\'s id and counts as Signup Code Sent (resend)', async () => {
    const w = world();
    const cookie = pendingCookieOf(await post(w, '/api/auth/signup', { email: EMAIL, password: SECRETS.password }));
    const again = await post(w, '/api/auth/signup/resend', { cf_turnstile_token: 'ok' }, cookie);
    expect(again.status).toBe(200);
    await settle();
    const sent = w.events().filter((e) => e.event === 'Signup Code Sent');
    expect(sent.map((e) => e.properties.send)).toEqual(['first', 'resend']);
    expect(new Set(w.events().map((e) => e.distinct_id)).size).toBe(1);
    expect(await lastCodeFor(w.env, EMAIL)).toMatch(/^\d{6}$/);
  });
});

describe('S1 request: src and from_checker', () => {
  it('the entry class is the closed list: checker is kept, anything else is other, none is cold', async () => {
    const w = world();
    await post(w, '/api/auth/signup', { email: EMAIL, password: SECRETS.password, src: 'checker', from_checker: true });
    await post(w, '/api/auth/signup', { email: SECRETS.emails[1], password: SECRETS.password, src: 'https://evil.example/x' });
    await post(w, '/api/auth/signup', { email: SECRETS.emails[3], password: SECRETS.password });
    await settle();
    expect(w.events().filter((e) => e.event === 'Signup Started').map((e) => [e.properties.entry, e.properties.from_checker])).toEqual([['checker', true], ['other', false], ['cold', false]]);
  });
});

describe('S4: Setup Path Chosen', () => {
  async function owner(w: ReturnType<typeof world>, email = EMAIL) { return w.signUp(email); }
  const chosen = (w: ReturnType<typeof world>) => w.events().filter((e) => e.event === 'Setup Path Chosen').map((e) => ({ path: e.properties.path, ...(e.properties.dns_provider ? { dns_provider: e.properties.dns_provider } : {}) }));

  it('the records path and the Cloudflare path, with the host as a category', async () => {
    const w = world();
    const t = await owner(w);
    expect((await w.api(t, 'POST', '/api/onboarding/setup-path', { path: 'records', dns_provider: 'godaddy' })).status).toBe(200);
    expect((await w.api(t, 'POST', '/api/onboarding/setup-path', { path: 'cloudflare', dns_provider: 'cloudflare' })).status).toBe(200);
    await settle();
    expect(chosen(w)).toEqual([{ path: 'records', dns_provider: 'godaddy' }, { path: 'cloudflare', dns_provider: 'cloudflare' }]);
  });

  it('a host the product does not recognise is "other" and none is "unknown": a typed value never travels', async () => {
    const w = world();
    const t = await owner(w);
    await w.api(t, 'POST', '/api/onboarding/setup-path', { path: 'records', dns_provider: 'harbor-lane-dns.example' });
    await w.api(t, 'POST', '/api/onboarding/setup-path', { path: 'records' });
    await settle();
    expect(chosen(w)).toEqual([{ path: 'records', dns_provider: 'other' }, { path: 'records', dns_provider: 'unknown' }]);
    for (const r of w.sent) expect(r.body).not.toContain('harbor-lane');
  });

  it('only the two paths the screen offers; a member cannot; nothing is changed by it', async () => {
    const w = world();
    const t = await owner(w);
    expect((await w.api(t, 'POST', '/api/onboarding/setup-path', { path: 'teammate' })).status).toBe(400);
    expect((await w.api(t, 'POST', '/api/onboarding/setup-path', { path: 'evil' })).status).toBe(400);
    const m = await inviteAndAccept(w.env, t, SECRETS.emails[1]!, 'member');
    expect((await w.api(m, 'POST', '/api/onboarding/setup-path', { path: 'records' })).status).toBe(403);
    await settle();
    expect(chosen(w)).toEqual([]);
  });

  it('handing setup to a teammate is the "teammate" choice', async () => {
    const w = world();
    const t = await owner(w);
    expect((await w.api(t, 'POST', '/api/domains', { domain: 'acme-walk.com' })).status).toBeLessThan(300);
    const r = await w.api(t, 'POST', '/api/team/invite', { email: 'mate@acme-walk.com', role: 'admin', handoff_domain: 'acme-walk.com' });
    expect(r.status).toBe(201);
    await settle();
    expect(chosen(w)).toEqual([{ path: 'teammate' }]);
  });

  it('off without PostHog: nothing is sent', async () => {
    const w = world({ POSTHOG_KEY: undefined, POSTHOG_HOST: undefined });
    const t = await owner(w);
    await w.api(t, 'POST', '/api/onboarding/setup-path', { path: 'records' });
    await settle();
    expect(w.sent).toEqual([]);
  });
});
