// Hand setup to a teammate (spec H1, H2, I1): the ordinary admin invite plus the domain to finish, an emailed fixed invitation, the
// invitee's routing data and the inviter's status list.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, enterCode, flushBackground, lastCodeFor, makeEnv, pendingCookieOf, signupVerified, inviteAndAccept } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import { handoffEmail } from '../../src/auth/mail';
import { MAX_OPEN_HANDOFFS } from '../../src/team/handoff';
import { dohFetch } from '../../packages/dns-checks/test/helpers';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
const json = async (r: Response) => await r.json() as any;
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.stubGlobal('fetch', dohFetch({}, [])); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function world(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const send = vi.fn(async () => {});
  const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send }, MAIL_REPLY_TO: 'hello@readysetmail.com', ...extra });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  return { db, env, send, rows };
}
type W = ReturnType<typeof world>;

/** An owner (named), with one domain claim in their workspace. */
async function owner(w: W, email = 'dana@brightwave-mail.com') {
  const key = await signupVerified(w.env, email);
  w.db.sqlite.prepare("UPDATE users SET name = 'Dana Whitfield' WHERE email = ?").run(email);
  const claim = await call(w.env, 'POST', '/api/domains', { key, body: { domain: 'brightwave-mail.com' } });
  expect(claim.status).toBe(202);
  return key;
}
const handoff = (w: W, key: string, over: Record<string, unknown> = {}) =>
  call(w.env, 'POST', '/api/team/invite', { key, body: { email: 'sam@brightwave-mail.com', role: 'admin', handoff_domain: 'brightwave-mail.com', ...over } });
const sentTo = (w: W, to: string) => w.send.mock.calls.map((c) => c[0] as any).filter((m) => m.to.includes(to) && !/is your Ready Set Mail code$/.test(m.subject));

describe('the hand-off invite', () => {
  it('is an admin invite that names the domain, emails the fixed invitation, and answers 201', async () => {
    const w = world();
    const key = await owner(w);
    const res = await handoff(w, key);
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.emailed).toBe(true);
    expect(w.rows('SELECT email, role, expires_at - created_at AS life FROM invites')).toEqual([{ email: 'sam@brightwave-mail.com', role: 'admin', life: 7 * 86400 }]);
    expect(w.rows("SELECT identifier FROM verifications WHERE identifier LIKE 'invite-handoff:%'")).toHaveLength(1);
    const [mail] = sentTo(w, 'sam@brightwave-mail.com');
    expect(mail.subject).toBe('Dana Whitfield asked you to finish setting up email for brightwave-mail.com');
    expect(mail.text).toContain('Dana Whitfield (dana@brightwave-mail.com) invited you to ');
    expect(mail.text).toContain(' on Ready Set Mail as an admin, to finish setting up SPF, DKIM and DMARC for brightwave-mail.com.');
    expect(mail.text).toContain(`/#/invite/${body.token}`);
    expect(mail.text).toContain('The link works for 7 days.');
    expect(mail.html).toMatch(/>readysetmail<\/span>/);
    expect(mail.html).toContain(`/#/invite/${body.token}`);
    expect(mail.html).not.toMatch(/<img|<svg|url\(|@import|<link/i);
    expect(mail.replyTo).toBe('hello@readysetmail.com');
  });

  it('works for a domain still waiting for proof, and for one already added', async () => {
    const w = world();
    const key = await owner(w);
    w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) SELECT workspace_id, 'harbor-lane.org', '', 'txt' FROM domain_claims LIMIT 1").run();
    expect((await handoff(w, key, { handoff_domain: 'harbor-lane.org', email: 'a@x.example' })).status).toBe(201);
    expect((await handoff(w, key, { handoff_domain: 'Brightwave-Mail.com', email: 'b@x.example' })).status).toBe(201);
  });

  it('is owner-only (it invites an admin), needs the admin role, and a hosted workspace', async () => {
    const w = world();
    const key = await owner(w);
    const adminKey = await inviteAndAccept(w.env, key, 'admin@brightwave-mail.com', 'admin');
    expect((await handoff(w, adminKey)).status).toBe(403);
    const memberKey = await inviteAndAccept(w.env, key, 'member@brightwave-mail.com', 'member');
    expect((await handoff(w, memberKey)).status).toBe(403);
    expect((await handoff(w, key, { role: 'member' })).status).toBe(400);
    expect((await handoff(w, key, { role: undefined })).status).toBe(400);
    expect((await handoff(w, key, { role: 'owner' })).status).toBe(400);
    expect(sentTo(w, 'sam@brightwave-mail.com')).toHaveLength(0);
  });

  it('the domain must belong to this workspace and be a valid name', async () => {
    const w = world();
    const key = await owner(w);
    const other = await signupVerified(w.env, 'eve@other.example');
    expect((await call(w.env, 'POST', '/api/domains', { key: other, body: { domain: 'other-domain.net' } })).status).toBe(202);
    for (const d of ['other-domain.net', 'nope.net']) expect((await handoff(w, key, { handoff_domain: d })).status).toBe(404);
    for (const d of ['not a domain', '', 42, null, 'https://x.com/path']) expect((await handoff(w, key, { handoff_domain: d })).status).toBe(400);
    expect(w.rows('SELECT 1 FROM invites')).toHaveLength(0);
  });

  it('keeps the existing rules: a bad address is refused, and a person already in the workspace is a conflict', async () => {
    const w = world();
    const key = await owner(w);
    expect((await handoff(w, key, { email: 'nope' })).status).toBe(400);
    expect((await handoff(w, key, { email: 'dana@brightwave-mail.com' })).status).toBe(409);
  });

  it('is bounded: at most 5 waiting at once', async () => {
    const w = world();
    const key = await owner(w);
    for (let i = 0; i < MAX_OPEN_HANDOFFS; i++) expect((await handoff(w, key, { email: `t${i}@x.example` })).status).toBe(201);
    const over = await handoff(w, key, { email: 'one-more@x.example' });
    expect(over.status).toBe(429);
    expect((await json(over)).code).toBe('handoff_limit');
    expect(sentTo(w, 'one-more@x.example')).toHaveLength(0);
  });

  it('a refused send is never answered as sent and leaves no invite behind', async () => {
    const w = world();
    const key = await owner(w);
    w.send.mockRejectedValueOnce(new Error('provider down'));
    const res = await handoff(w, key);
    expect(res.status).toBe(503);
    expect((await json(res)).code).toBe('handoff_not_sent');
    expect(w.rows('SELECT 1 FROM invites')).toHaveLength(0);
    expect(w.rows("SELECT 1 FROM verifications WHERE identifier LIKE 'invite-handoff:%'")).toHaveLength(0);
    expect((await handoff(w, key)).status).toBe(201);
  });

  it('an ordinary invite is unchanged: no email, no hand-off row, and the invite page has no hand-off', async () => {
    const w = world();
    const key = await owner(w);
    const res = await call(w.env, 'POST', '/api/team/invite', { key, body: { email: 'sam@brightwave-mail.com', role: 'admin' } });
    expect(res.status).toBe(201);
    const { token } = await json(res);
    expect(sentTo(w, 'sam@brightwave-mail.com')).toHaveLength(0);
    const info = await json(await call(w.env, 'GET', `/api/invites/${token}`));
    expect(info).toMatchObject({ email: 'sam@brightwave-mail.com', role: 'admin' });
    expect(info.handoff).toBeUndefined();
  });
});

describe('the invitee (I1)', () => {
  it('the invite page says what to finish and who asked; accepting with the code reports the domain to land on, and gives no S2', async () => {
    const w = world();
    const key = await owner(w);
    const { token } = await json(await handoff(w, key));
    const info = await json(await call(w.env, 'GET', `/api/invites/${token}`));
    expect(info).toMatchObject({ role: 'admin', handoff: { domain: 'brightwave-mail.com', inviter_name: 'Dana Whitfield' } });

    const accepted = await call(w.env, 'POST', `/api/invites/${token}`, { body: { password: 'sam-password-1' } });
    expect(accepted.status).toBe(200);
    const done = await enterCode(w.env, pendingCookieOf(accepted), await lastCodeFor(w.env, 'sam@brightwave-mail.com'));
    expect(done.status).toBe(200);
    const body = await json(done);
    expect(body).toMatchObject({ purpose: 'invite', handoff_domain: 'brightwave-mail.com' });
    expect(w.rows("SELECT m.role AS role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'sam@brightwave-mail.com' AND m.workspace_id = ?", body.workspace_id)).toEqual([{ role: 'admin' }]);
    // no profile questions: nothing was asked or stored for them
    expect(w.rows("SELECT 1 FROM verifications WHERE identifier LIKE 'account-profile:%'")).toHaveLength(0);
  });

  it('an ordinary invite accepted by code reports no domain (it lands on the dashboard)', async () => {
    const w = world();
    const key = await owner(w);
    const { token } = await json(await call(w.env, 'POST', '/api/team/invite', { key, body: { email: 'sam@brightwave-mail.com', role: 'admin' } }));
    const accepted = await call(w.env, 'POST', `/api/invites/${token}`, { body: { password: 'sam-password-1' } });
    const done = await json(await enterCode(w.env, pendingCookieOf(accepted), await lastCodeFor(w.env, 'sam@brightwave-mail.com')));
    expect(done.handoff_domain).toBeUndefined();
  });

  it('someone who already has a login accepts with one click and is told the domain too', async () => {
    const w = world();
    const key = await owner(w);
    const samKey = await signupVerified(w.env, 'sam@brightwave-mail.com');
    const { token } = await json(await handoff(w, key));
    const res = await call(w.env, 'POST', `/api/invites/${token}`, { key: samKey, body: {} });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, handoff_domain: 'brightwave-mail.com' });
  });
});

describe('where it stands (H2) and resend', () => {
  it('lists the hand-off as sent, then joined; only owners and admins can read it', async () => {
    const w = world();
    const key = await owner(w);
    const { token } = await json(await handoff(w, key));
    let list = (await json(await call(w.env, 'GET', '/api/team/handoffs', { key }))).handoffs;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ email: 'sam@brightwave-mail.com', domain: 'brightwave-mail.com', joined_at: null });
    expect(list[0].expires_at - list[0].sent_at).toBeGreaterThanOrEqual(7 * 86400 - 5);
    expect(JSON.stringify(list)).not.toContain(token); // the link stays with the invitee
    const accepted = await call(w.env, 'POST', `/api/invites/${token}`, { body: { password: 'sam-password-1' } });
    await enterCode(w.env, pendingCookieOf(accepted), await lastCodeFor(w.env, 'sam@brightwave-mail.com'));
    list = (await json(await call(w.env, 'GET', '/api/team/handoffs', { key }))).handoffs;
    expect(list[0].joined_at).toBeGreaterThan(0);
    const member = await inviteAndAccept(w.env, key, 'm@brightwave-mail.com', 'member');
    expect((await call(w.env, 'GET', '/api/team/handoffs', { key: member })).status).toBe(403);
  });

  it('another workspace never sees it', async () => {
    const w = world();
    const key = await owner(w);
    await handoff(w, key);
    const other = await signupVerified(w.env, 'eve@other.example');
    expect((await json(await call(w.env, 'GET', '/api/team/handoffs', { key: other }))).handoffs).toEqual([]);
  });

  it('resend gives a new link by email, the old link stops working, and a joined hand-off cannot be resent', async () => {
    const w = world();
    const key = await owner(w);
    const first = await json(await handoff(w, key));
    const [{ id }] = (await json(await call(w.env, 'GET', '/api/team/handoffs', { key }))).handoffs;
    const res = await call(w.env, 'POST', `/api/team/handoffs/${id}/resend`, { key, body: {} });
    expect(res.status).toBe(201);
    const second = await json(res);
    expect(second.token).not.toBe(first.token);
    expect((await call(w.env, 'GET', `/api/invites/${first.token}`)).status).toBe(404);
    expect((await call(w.env, 'GET', `/api/invites/${second.token}`)).status).toBe(200);
    expect(sentTo(w, 'sam@brightwave-mail.com')).toHaveLength(2);
    expect((await json(await call(w.env, 'GET', '/api/team/handoffs', { key }))).handoffs).toHaveLength(1);

    const accepted = await call(w.env, 'POST', `/api/invites/${second.token}`, { body: { password: 'sam-password-1' } });
    await enterCode(w.env, pendingCookieOf(accepted), await lastCodeFor(w.env, 'sam@brightwave-mail.com'));
    const [{ id: id2 }] = (await json(await call(w.env, 'GET', '/api/team/handoffs', { key }))).handoffs;
    expect((await call(w.env, 'POST', `/api/team/handoffs/${id2}/resend`, { key, body: {} })).status).toBe(409);
    expect((await call(w.env, 'POST', '/api/team/handoffs/deadbeef/resend', { key, body: {} })).status).toBe(404);
  });
});

describe('the invitation email', () => {
  const m = handoffEmail({ inviterName: 'Dana Whitfield', inviterEmail: 'dana@brightwave-mail.com', workspaceName: 'Brightwave Studio', domain: 'brightwave-mail.com', url: 'https://app.example/#/invite/t' });
  it('has the spec\'s fixed wording', () => {
    expect(m.subject).toBe('Dana Whitfield asked you to finish setting up email for brightwave-mail.com');
    expect(m.text).toBe('Dana Whitfield (dana@brightwave-mail.com) invited you to Brightwave Studio on Ready Set Mail as an admin, to finish setting up SPF, DKIM and DMARC for brightwave-mail.com.\n\nhttps://app.example/#/invite/t\n\nThe link works for 7 days.');
    expect(m.html).toContain('Open Ready Set Mail');
  });
  it('lets no typed text change its shape: names are cleaned, markup is escaped', () => {
    const x = handoffEmail({ inviterName: 'Eve‮\nBcc: x@y.z', inviterEmail: 'e@x.example', workspaceName: '<b>Acme</b>', domain: 'x.com', url: 'https://app.example/#/invite/t' });
    expect(x.subject).not.toMatch(/[\r\n‮]/);
    expect(x.html).not.toContain('<b>Acme</b>');
    expect(x.html).toContain('&lt;b&gt;Acme&lt;/b&gt;');
  });
});
