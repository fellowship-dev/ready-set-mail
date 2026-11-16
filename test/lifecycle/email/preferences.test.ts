// Preferences and one-click unsubscribe of the lifecycle emails (spec test category 4).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { funnelQueries } from '@ready-set-mail/db';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { TenantContext } from '../../../src/tenancy/context';
import { handleApi } from '../../../src/api/router';
import { handleEmailPreferenceOff, handleEmailPreferences, OFF_PATH } from '../../../src/lifecycle/email/routes';
import { preferenceOffUrl } from '../../../src/lifecycle/email/preferences';
import { signToken, verifyToken } from '../../../src/mail/tokens';
import { unsubscribeUrl } from '../../../src/mail/compliance';
import { call, makeEnv } from '../../auth/helpers';
import { billingWorld } from '../../billing/world';
import { DAY, WEEK_9_NOV, WS, lifecycleWorld, recordNamingUs, type World } from './world';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const DOMAIN = 'brightwave-mail.com';
const ONE_CLICK = 'List-Unsubscribe=One-Click';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const SENDGRID = { ip: '192.0.2.50', count: 20, spf: ['pass', 'sendgrid.net'] as [string, string], dkim: ['pass', 'sendgrid.net'] as [string, string], org: 'SendGrid' };
const GOOD = { ip: '192.0.2.10', count: 30, spf: ['pass', DOMAIN] as [string, string], dkim: ['pass', DOMAIN] as [string, string], org: 'Google Workspace' };

/** Hosted workspace whose last complete week (9-15 Nov) had reports with one failing third-party source: a summary and a tip are due on Mon 16 Nov. */
async function weeklyWorld(extra: Record<string, unknown> = {}, { owner = true }: { owner?: boolean } = {}) {
  // Tips are off until the instance names them (LIFECYCLE_EMAILS_ON) and each person opts in: this world has both, for Dana, unless `owner` is false.
  const w = await lifecycleWorld({ LIFECYCLE_EMAILS_ON: 'tips', ...extra });
  vi.restoreAllMocks();
  if (owner) w.pref(w.dana, 'tips', true);
  w.addDomain({ domain: DOMAIN });
  w.addReport({ domain: DOMAIN, day: WEEK_9_NOV, total: 50, passed: 30, records: [GOOD, SENDGRID] });
  return w;
}
const summaryTo = (w: World) => w.mailer.sent.filter((m) => /^Week of /.test(m.subject)).map((m) => m.to);
const tipsTo = (w: World) => w.mailer.sent.filter((m) => /needs SPF or DKIM|every message passed DMARC/.test(m.subject)).map((m) => m.to);
const prefs = (w: World) => w.rows('SELECT user_id, workspace_id, kind, enabled FROM email_preferences ORDER BY user_id, workspace_id, kind');
const tokenOf = (url: string) => new URL(url).searchParams.get('t')!;

const postOff = (w: World, url: string, body: string | null = ONE_CLICK, headers: Record<string, string> = FORM) =>
  handleApi(new Request(url, { method: 'POST', headers, body }), w.env as never, ctx);
const getOff = (w: World, url: string) => handleApi(new Request(url, { method: 'GET' }), w.env as never, ctx);

async function secondWorkspace(w: World) {
  w.sql.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run('ws_other', 'Other Studio');
  w.sql.prepare("INSERT INTO users (id, email, name, role, email_verified) VALUES ('u_eve', 'eve@other.example', 'Eve Other', 'admin', 1)").run();
  w.sql.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES ('ws_other', 'u_eve', 'owner')").run();
  // Dana is an owner of the second workspace too.
  w.sql.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES ('ws_other', 'u_dana', 'owner')").run();
  for (const [u, ws, k] of [['u_eve', 'ws_other', 'summary'], ['u_eve', 'ws_other', 'tips'], ['u_dana', 'ws_other', 'summary'], ['u_dana', 'ws_other', 'tips'], ['u_dana', WS, 'tips']] as const) {
    w.sql.prepare('INSERT INTO email_preferences (user_id, workspace_id, kind, enabled) VALUES (?, ?, ?, 1)').run(u, ws, k);
  }
}

describe('one-click: POST turns off exactly one preference, with no session and no cookies', () => {
  it('through the real router', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const url = (await preferenceOffUrl(w.env, w.dana, WS, 'summary'))!;
    expect(url).toMatch(/^https:\/\/app\.readysetmail\.com\/api\/email-preferences\/off\?t=/);
    const req = new Request(url, { method: 'POST', headers: FORM, body: ONE_CLICK });
    expect(req.headers.get('cookie')).toBeNull();
    expect(req.headers.get('authorization')).toBeNull();
    const res = await handleApi(req, w.env as never, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(prefs(w)).toEqual([{ user_id: w.dana, workspace_id: WS, kind: 'summary', enabled: 0 }]);
    // Setting no cookies either.
    expect(res.headers.get('set-cookie')).toBeNull();
    const html = await res.text();
    expectPlainPage(html);
    expect(html).toContain('is off');
  });

  it('through handleEmailPreferenceOff, which takes no session at all (only the request and the environment)', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const url = (await preferenceOffUrl(w.env, w.dana, WS, 'tips'))!;
    const res = await handleEmailPreferenceOff(new Request(url, { method: 'POST', headers: FORM, body: ONE_CLICK }), w.env);
    expect(res!.status).toBe(200);
    expect(await handleEmailPreferenceOff(new Request('https://app.readysetmail.com/api/other'), w.env)).toBeNull();
    expect(prefs(w)).toEqual([{ user_id: w.dana, workspace_id: WS, kind: 'tips', enabled: 0 }]);
  });

  it('is idempotent and an off stays off', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const url = (await preferenceOffUrl(w.env, w.dana, WS, 'summary'))!;
    expect((await postOff(w, url)).status).toBe(200);
    expect((await postOff(w, url)).status).toBe(200);
    expect(prefs(w)).toEqual([{ user_id: w.dana, workspace_id: WS, kind: 'summary', enabled: 0 }]);
  });

  it('a person who is no longer a member gets the same answer and no row', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const url = (await preferenceOffUrl(w.env, w.dana, WS, 'summary'))!;
    w.sql.prepare('DELETE FROM memberships WHERE user_id = ?').run(w.dana);
    expect((await postOff(w, url)).status).toBe(200);
    expect(prefs(w)).toEqual([]);
  });

  it('a POST without the One-Click body is 400 and changes nothing', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const url = (await preferenceOffUrl(w.env, w.dana, WS, 'summary'))!;
    for (const [body, headers] of [[null, {}], ['', FORM], ['x=1', FORM], ['List-Unsubscribe=No', FORM], ['list-unsubscribe=one-click', FORM]] as const) {
      expect((await postOff(w, url, body, headers)).status, JSON.stringify([body, headers])).toBe(400);
    }
    expect(prefs(w)).toEqual([]);
  });

  it('other methods are 405', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const url = (await preferenceOffUrl(w.env, w.dana, WS, 'summary'))!;
    for (const method of ['PUT', 'DELETE']) {
      const res = await handleApi(new Request(url, { method, headers: FORM, body: ONE_CLICK }), w.env as never, ctx);
      expect(res.status).toBe(405);
    }
    expect(prefs(w)).toEqual([]);
  });
});

/** A plain page: no images, scripts, stylesheets or any other external asset. */
function expectPlainPage(html: string) {
  expect(html).not.toMatch(/<img/i);
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<link/i);
  expect(html).not.toMatch(/\bsrc\s*=/i);
  expect(html).not.toMatch(/url\(/i);
  expect(html).not.toMatch(/@import/i);
  expect(html).not.toMatch(/<iframe/i);
  // No http(s) reference of any kind to load: the only `href`s allowed are none.
  expect(html).not.toMatch(/https?:\/\//i);
}

describe('GET only asks', () => {
  it('shows the question and a POST form, and changes nothing', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    w.sql.prepare("INSERT INTO email_preferences (user_id, workspace_id, kind, enabled) VALUES (?, ?, 'tips', 1)").run(w.dana, WS);
    const before = prefs(w);
    const url = (await preferenceOffUrl(w.env, w.dana, WS, 'summary'))!;
    const res = await getOff(w, url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Turn off the weekly summary for Brightwave Studio?');
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/api\/email-preferences\/off\?t=/i);
    expect(html).toContain('name="List-Unsubscribe"');
    expect(html).toContain('value="One-Click"');
    expectPlainPage(html);
    expect(prefs(w)).toEqual(before);
    // the form's action carries the same token
    const action = html.match(/action="([^"]+)"/)![1]!.replace(/&amp;/g, '&');
    expect(decodeURIComponent(action.split('t=')[1]!)).toBe(tokenOf(url));
  });

  it('names the tips question for a tips token', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const html = await (await getOff(w, (await preferenceOffUrl(w.env, w.dana, WS, 'tips'))!)).text();
    expect(html).toContain('Turn off tips about your domains for Brightwave Studio?');
  });

  it('pressing the button of the page (the form it shows) turns the preference off', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const url = (await preferenceOffUrl(w.env, w.dana, WS, 'summary'))!;
    const html = await (await getOff(w, url)).text();
    const action = html.match(/action="([^"]+)"/)![1]!.replace(/&amp;/g, '&');
    const res = await postOff(w, new URL(action, url).toString(), 'List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect(prefs(w)).toEqual([{ user_id: w.dana, workspace_id: WS, kind: 'summary', enabled: 0 }]);
  });

  it('a garbage token is 400 on GET and POST and changes nothing', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const base = `https://app.readysetmail.com${OFF_PATH}`;
    for (const t of ['garbage', '', 'a.b', 'a.b.c', '....', '%00']) {
      const url = `${base}?t=${encodeURIComponent(t)}`;
      expect((await getOff(w, url)).status).toBe(400);
      expect((await postOff(w, url)).status).toBe(400);
    }
    expect((await getOff(w, base)).status).toBe(400);
    expect((await postOff(w, base)).status).toBe(400);
    expect(prefs(w)).toEqual([]);
    expect((await (await getOff(w, `${base}?t=garbage`)).text())).not.toMatch(/https?:\/\//);
  });
});

describe('a token is scoped to one user, one workspace and one preference', () => {
  it('a summary token never changes the tips row, another user, or another workspace', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const admin = w.addUser({ id: 'u_admin', email: 'sam@brightwave-mail.com', name: 'Sam Admin', role: 'admin' });
    await secondWorkspace(w);
    w.sql.prepare("INSERT INTO email_preferences (user_id, workspace_id, kind, enabled) VALUES (?, ?, 'summary', 1)").run(admin, WS);
    w.sql.prepare("INSERT INTO email_preferences (user_id, workspace_id, kind, enabled) VALUES (?, ?, 'tips', 1)").run(admin, WS);
    w.sql.prepare("INSERT INTO email_preferences (user_id, workspace_id, kind, enabled) VALUES (?, ?, 'summary', 1)").run(w.dana, WS);
    const before = prefs(w);
    expect(before.every((r) => r.enabled === 1)).toBe(true);

    expect((await postOff(w, (await preferenceOffUrl(w.env, w.dana, WS, 'summary'))!)).status).toBe(200);

    const after = prefs(w);
    const changed = after.filter((r, i) => JSON.stringify(r) !== JSON.stringify(before[i]));
    expect(after).toHaveLength(before.length);
    expect(changed).toEqual([{ user_id: w.dana, workspace_id: WS, kind: 'summary', enabled: 0 }]);
    // Dana's tips in WS, her rows in the other workspace and everybody else's rows are all still on.
    expect(after.filter((r) => r.enabled === 1)).toHaveLength(before.length - 1);
  });

  it('the token of the other workspace changes that workspace only', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    await secondWorkspace(w);
    expect((await postOff(w, (await preferenceOffUrl(w.env, w.dana, 'ws_other', 'tips'))!)).status).toBe(200);
    expect(prefs(w).filter((r) => r.enabled === 0)).toEqual([{ user_id: w.dana, workspace_id: 'ws_other', kind: 'tips', enabled: 0 }]);
  });

  it('a token for a workspace the person is not a member of changes nothing', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    await secondWorkspace(w);
    // Eve is not in Brightwave Studio.
    expect((await postOff(w, (await preferenceOffUrl(w.env, 'u_eve', WS, 'summary'))!)).status).toBe(200);
    expect(prefs(w).filter((r) => r.enabled === 0)).toEqual([]);
    expect(prefs(w).some((r) => r.user_id === 'u_eve' && r.workspace_id === WS)).toBe(false);
  });
});

describe('tampered and other-purpose tokens are refused', () => {
  const flip = (s: string, i: number) => `${s.slice(0, i)}${s[i] === 'A' ? 'B' : 'A'}${s.slice(i + 1)}`;

  it('flipped, truncated or extended tokens are 400 on POST and GET', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const good = tokenOf((await preferenceOffUrl(w.env, w.dana, WS, 'summary'))!);
    const [body, mac] = good.split('.') as [string, string];
    const bad = [
      flip(good, 3), flip(good, body.length - 3), flip(good, body.length + 1 + 3), flip(good, good.length - 2),
      good.slice(0, -4), good.slice(0, body.length), `${body}.`, `.${mac}`, body, mac,
      `${good}.extra`, `${good}.${mac}`, `${body}.${mac}.${mac}`, `x${good}`,
      `${mac}.${body}`,
    ];
    for (const t of bad) {
      const url = `https://app.readysetmail.com${OFF_PATH}?t=${encodeURIComponent(t)}`;
      expect((await postOff(w, url)).status, `POST ${t.slice(0, 12)}`).toBe(400);
      expect((await getOff(w, url)).status, `GET ${t.slice(0, 12)}`).toBe(400);
    }
    expect(prefs(w)).toEqual([]);
    // The untouched token still works.
    expect((await postOff(w, `https://app.readysetmail.com${OFF_PATH}?t=${encodeURIComponent(good)}`)).status).toBe(200);
  });

  it('a token signed with another secret is refused', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const t = await signToken({ ...w.env, BETTER_AUTH_SECRET: 'another-secret' } as never, { p: 'pref', u: w.dana, w: WS, k: 'summary' });
    expect((await postOff(w, `https://app.readysetmail.com${OFF_PATH}?t=${encodeURIComponent(t)}`)).status).toBe(400);
    expect(prefs(w)).toEqual([]);
  });

  it('unsub and confirm tokens never validate on /off; pref tokens never validate on /api/unsubscribe and suppress nothing', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const unsub = await signToken(w.env, { p: 'unsub', e: 'dana@brightwave-mail.com' });
    const confirm = await signToken(w.env, { p: 'confirm', e: 'dana@brightwave-mail.com', w: WS, s: 1, x: Math.floor(Date.now() / 1000) + 3600 });
    for (const t of [unsub, confirm]) {
      const url = `https://app.readysetmail.com${OFF_PATH}?t=${encodeURIComponent(t)}`;
      expect((await postOff(w, url)).status).toBe(400);
      expect((await getOff(w, url)).status).toBe(400);
    }
    expect(prefs(w)).toEqual([]);

    for (const kind of ['summary', 'tips'] as const) {
      const t = tokenOf((await preferenceOffUrl(w.env, w.dana, WS, kind))!);
      const url = `https://app.readysetmail.com/api/unsubscribe?t=${encodeURIComponent(t)}`;
      expect((await postOff(w, url)).status).toBe(400);
      expect((await getOff(w, url)).status).toBe(400);
    }
    expect(w.rows('SELECT * FROM suppression')).toEqual([]);
    expect(await funnelQueries(w.env.DB).suppression.has('dana@brightwave-mail.com')).toBe(false);
    expect(prefs(w)).toEqual([]);

    // Control: the real unsub token does work on its own route, so the refusal above is about the purpose.
    const ok = await postOff(w, (await unsubscribeUrl(w.env, 'dana@brightwave-mail.com'))!);
    expect(ok.status).toBe(200);
    expect(w.rows('SELECT * FROM suppression')).toHaveLength(1);
  });
});

describe('verifyToken for pref payloads', () => {
  it('round trips', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    for (const k of ['summary', 'tips'] as const) {
      const t = await signToken(w.env, { p: 'pref', u: 'u_dana', w: WS, k });
      expect(await verifyToken(w.env, t)).toEqual({ p: 'pref', u: 'u_dana', w: WS, k });
    }
  });
  it('does not expire', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const t = await signToken(w.env, { p: 'pref', u: 'u_dana', w: WS, k: 'tips' });
    expect(await verifyToken(w.env, t, Math.floor(Date.now() / 1000) + 20 * 365 * DAY)).toMatchObject({ p: 'pref', k: 'tips' });
  });
  it('is null for missing or other fields', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const sign = (p: unknown) => signToken(w.env, p as never);
    for (const p of [
      { p: 'pref', u: 'u_dana', w: WS, k: 'other' },
      { p: 'pref', u: 'u_dana', w: WS },
      { p: 'pref', u: 'u_dana', k: 'summary' },
      { p: 'pref', w: WS, k: 'summary' },
      { p: 'pref', u: '', w: WS, k: 'summary' },
      { p: 'pref', u: 'u_dana', w: '', k: 'summary' },
      { p: 'pref', u: 1, w: WS, k: 'summary' },
      { p: 'pref', u: 'u_dana', w: WS, k: 'milestone' },
      { p: 'other', u: 'u_dana', w: WS, k: 'summary' },
      { p: 'unsub' },
    ]) expect(await verifyToken(w.env, await sign(p)), JSON.stringify(p)).toBeNull();
  });
  it('a pref token is not an unsub payload', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    const p = (await verifyToken(w.env, await signToken(w.env, { p: 'pref', u: 'u', w: WS, k: 'summary' })))!;
    expect(p.p).toBe('pref');
    expect('e' in p).toBe(false);
  });
});

describe('a change is effective on the next send', () => {
  it('control: the weekly summary and a tip are sent to the owner', async () => {
    const w = await weeklyWorld();
    await w.run();
    expect(summaryTo(w)).toEqual(['dana@brightwave-mail.com']);
    expect(tipsTo(w)).toEqual(['dana@brightwave-mail.com']);
  });

  it('turning the summary off through the route before run() sends no summary (the tip is unaffected)', async () => {
    const w = await weeklyWorld();
    expect((await postOff(w, (await preferenceOffUrl(w.env, w.dana, WS, 'summary'))!)).status).toBe(200);
    await w.run();
    expect(summaryTo(w)).toEqual([]);
    expect(tipsTo(w)).toEqual(['dana@brightwave-mail.com']);
  });

  it('turning tips off sends no tip (the summary is unaffected)', async () => {
    const w = await weeklyWorld();
    expect((await postOff(w, (await preferenceOffUrl(w.env, w.dana, WS, 'tips'))!)).status).toBe(200);
    await w.run();
    expect(tipsTo(w)).toEqual([]);
    expect(summaryTo(w)).toEqual(['dana@brightwave-mail.com']);
  });

  it('an admin gets nothing until they opt in; opting in sends it; opting out through the route stops it', async () => {
    const w = await weeklyWorld();
    const admin = w.addUser({ id: 'u_admin', email: 'sam@brightwave-mail.com', name: 'Sam Admin', role: 'admin' });
    await w.run();
    expect(summaryTo(w)).toEqual(['dana@brightwave-mail.com']);
    expect(tipsTo(w)).toEqual(['dana@brightwave-mail.com']);

    // Opt in, and run the same week again as a later invocation: the new choice is read at send time.
    w.pref(admin, 'summary', true);
    w.pref(admin, 'tips', true);
    await w.run();
    expect(summaryTo(w).sort()).toEqual(['dana@brightwave-mail.com', 'sam@brightwave-mail.com']);
    expect(tipsTo(w).sort()).toEqual(['dana@brightwave-mail.com', 'sam@brightwave-mail.com']);
  });

  it('an admin who opted in and then used the link gets nothing the next week', async () => {
    const w = await weeklyWorld();
    const admin = w.addUser({ id: 'u_admin', email: 'sam@brightwave-mail.com', name: 'Sam Admin', role: 'admin' });
    w.pref(admin, 'summary', true);
    expect((await postOff(w, (await preferenceOffUrl(w.env, admin, WS, 'summary'))!)).status).toBe(200);
    await w.run();
    expect(summaryTo(w)).toEqual(['dana@brightwave-mail.com']);
  });

  it('members never receive the summary or tips, even with a stored "on"', async () => {
    const w = await weeklyWorld();
    const member = w.addUser({ id: 'u_member', email: 'pat@brightwave-mail.com', name: 'Pat Member', role: 'member' });
    w.pref(member, 'summary', true);
    w.pref(member, 'tips', true);
    await w.run();
    expect(w.mailer.sent.map((m) => m.to)).not.toContain('pat@brightwave-mail.com');
    expect(summaryTo(w)).toEqual(['dana@brightwave-mail.com']);
  });

  it('members and admins get no milestone email (the admin only when the audit log says they added the domain)', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    w.addUser({ id: 'u_member', email: 'pat@brightwave-mail.com', name: 'Pat Member', role: 'member' });
    w.addUser({ id: 'u_admin', email: 'sam@brightwave-mail.com', name: 'Sam Admin', role: 'admin' });
    w.addDomain({ domain: DOMAIN });
    w.dns.set(DOMAIN, recordNamingUs());
    await w.run();
    expect(w.mailer.sent.map((m) => m.to)).toEqual(['dana@brightwave-mail.com']);
  });
});

describe('unverified and suppressed addresses', () => {
  it('a user with email_verified = 0 receives nothing, of any kind', async () => {
    const w = await weeklyWorld();
    w.sql.prepare('UPDATE users SET email_verified = 0 WHERE id = ?').run(w.dana);
    w.addDomain({ domain: 'new-site.example' });
    w.dns.set('new-site.example', recordNamingUs());
    await w.run();
    expect(w.mailer.sent).toEqual([]);
    expect(w.sends()).toEqual([]);
  });

  it('a verified owner still gets it when only another person is unverified', async () => {
    const w = await weeklyWorld();
    const admin = w.addUser({ id: 'u_admin', email: 'sam@brightwave-mail.com', name: 'Sam Admin', role: 'admin', verified: false });
    w.pref(admin, 'summary', true);
    await w.run();
    expect(summaryTo(w)).toEqual(['dana@brightwave-mail.com']);
  });

  it('a suppressed address receives nothing for any kind, including milestone emails, and the claim is released', async () => {
    const w = await weeklyWorld();
    w.addDomain({ domain: 'new-site.example' });
    w.dns.set('new-site.example', recordNamingUs());
    await funnelQueries(w.env.DB).suppression.add('Dana@Brightwave-Mail.com', 'unsubscribe');
    await w.run();
    expect(w.mailer.sent).toEqual([]);
    expect(w.sends()).toEqual([]);

    // Removing the suppression lets the same run's emails go out: nothing was spent.
    w.sql.prepare('DELETE FROM suppression').run();
    await w.run();
    const subjects = w.mailer.sent.map((m) => m.subject);
    expect(subjects.some((s) => /^Week of /.test(s))).toBe(true);
    expect(subjects.some((s) => /is set up: reports are on their way/.test(s))).toBe(true);
    await w.run(); // the 3-per-run cap pushed the tip to the next run
    expect(w.mailer.sent.map((m) => m.subject).some((s) => /needs SPF or DKIM/.test(s))).toBe(true);
    expect(w.sends().every((s) => s.state === 'sent')).toBe(true);
  });

  it('suppressing one person leaves the others served', async () => {
    const w = await weeklyWorld();
    const admin = w.addUser({ id: 'u_admin', email: 'sam@brightwave-mail.com', name: 'Sam Admin', role: 'admin' });
    w.pref(admin, 'summary', true);
    await funnelQueries(w.env.DB).suppression.add('dana@brightwave-mail.com', 'unsubscribe');
    await w.run();
    expect(summaryTo(w)).toEqual(['sam@brightwave-mail.com']);
  });
});

describe('defaults and kill switches', () => {
  it('an owner with no stored choice gets the summary and no tip, even where the instance sends tips', async () => {
    const w = await weeklyWorld({}, { owner: false });
    await w.run();
    expect(tipsTo(w)).toEqual([]);
    expect(summaryTo(w)).toEqual(['dana@brightwave-mail.com']);
  });

  it('an explicit "on" row is the only way to get tips', async () => {
    const w = await weeklyWorld({}, { owner: false });
    w.pref(w.dana, 'tips', true);
    await w.run();
    expect(tipsTo(w)).toEqual(['dana@brightwave-mail.com']);
  });

  it('an explicit "off" row wins', async () => {
    const w = await weeklyWorld();
    w.pref(w.dana, 'tips', false);
    await w.run();
    expect(tipsTo(w)).toEqual([]);
  });

  it('admins never get tips or the summary without choosing', async () => {
    const w = await weeklyWorld();
    w.addUser({ id: 'u_admin', email: 'sam@brightwave-mail.com', name: 'Sam Admin', role: 'admin' });
    await w.run();
    expect(w.mailer.sent.map((m) => m.to)).not.toContain('sam@brightwave-mail.com');
  });

  it('the preference has no environment default any more: LIFECYCLE_TIPS_DEFAULT does nothing', async () => {
    for (const v of ['on', 'off', 'whatever']) {
      const w = await weeklyWorld({ LIFECYCLE_TIPS_DEFAULT: v }, { owner: false });
      await w.run();
      expect(tipsTo(w), v).toEqual([]);
    }
  });

  describe('the instance switch: hosted sends tips only when LIFECYCLE_EMAILS_ON names them', () => {
    const tips = async (env: Record<string, unknown>, optedIn = true) => {
      const w = await weeklyWorld({ LIFECYCLE_EMAILS_ON: undefined, ...env }, { owner: optedIn });
      await w.run();
      return tipsTo(w);
    };
    it('unset: none, even for a person who opted in', async () => expect(await tips({})).toEqual([]));
    it('ON=tips and the person opted in: sent', async () => expect(await tips({ LIFECYCLE_EMAILS_ON: 'tips' })).toEqual(['dana@brightwave-mail.com']));
    it('ON=tips (among others, any case) and the person opted in: sent', async () => expect(await tips({ LIFECYCLE_EMAILS_ON: 'change_alerts, Tips' })).toEqual(['dana@brightwave-mail.com']));
    it('ON=tips but the person did not opt in: none', async () => expect(await tips({ LIFECYCLE_EMAILS_ON: 'tips' }, false)).toEqual([]));
    it('ON=tips and OFF=tips: none (OFF wins)', async () => expect(await tips({ LIFECYCLE_EMAILS_ON: 'tips', LIFECYCLE_EMAILS_OFF: 'tips' })).toEqual([]));
    it('ON=change_alerts only: none', async () => expect(await tips({ LIFECYCLE_EMAILS_ON: 'change_alerts' })).toEqual([]));
  });

  const sendKinds = async (off: string | undefined) => {
    const w = await weeklyWorld({ LIFECYCLE_EMAILS_OFF: off });
    w.addDomain({ domain: 'new-site.example' });
    w.dns.set('new-site.example', recordNamingUs());
    await w.run();
    await w.run(); // at most 3 emails per person per run: what did not fit goes out on the next one
    return {
      summary: summaryTo(w).length > 0,
      tips: tipsTo(w).length > 0,
      live: w.mailer.sent.some((m) => /is set up: reports are on their way/.test(m.subject)),
      total: w.mailer.sent.length,
    };
  };

  it('control: everything is sent (tips on for this instance and for Dana) with the switch unset', async () => {
    expect(await sendKinds(undefined)).toMatchObject({ summary: true, tips: true, live: true });
  });
  it('all stops everything', async () => {
    expect(await sendKinds('all')).toEqual({ summary: false, tips: false, live: false, total: 0 });
    expect(await sendKinds(' ALL ')).toMatchObject({ total: 0 });
    expect(await sendKinds('summary, all')).toMatchObject({ total: 0 });
  });
  it('a list stops those kinds only', async () => {
    expect(await sendKinds('summary,no_reports')).toMatchObject({ summary: false, tips: true, live: true });
    expect(await sendKinds('records_live')).toMatchObject({ summary: true, tips: true, live: false });
  });
  it('tips stops all three tip kinds', async () => {
    expect(await sendKinds('tips')).toMatchObject({ summary: true, tips: false, live: true });
  });
  it('unknown words stop nothing', async () => {
    expect(await sendKinds('weekly,tip_fix,none,off,')).toMatchObject({ summary: true, tips: true, live: true });
  });
});

describe('session API: GET and PUT /api/email-preferences', () => {
  it('shows an owner both emails offered, the summary on and tips off by default, and changes only that owner\'s own row', async () => {
    const w = await billingWorld({ LIFECYCLE_EMAILS_ON: 'tips' }, { stripe: false });
    const rows = (q: string, ...p: unknown[]) => w.db.sqlite.prepare(q).all(...p) as any[];
    const get = async (p = w.owner) => ({ res: await w.api(p, 'GET', '/api/email-preferences') });
    const first = await get();
    expect(first.res.status).toBe(200);
    expect(await first.res.json()).toEqual({ role: 'owner', summary: { offered: true, enabled: true }, tips: { offered: true, enabled: false } });

    const put = await w.api(w.owner, 'PUT', '/api/email-preferences', { kind: 'summary', enabled: false });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ role: 'owner', summary: { offered: true, enabled: false }, tips: { offered: true, enabled: false } });
    expect(rows('SELECT workspace_id, kind, enabled FROM email_preferences')).toEqual([{ workspace_id: w.owner.workspaceId, kind: 'summary', enabled: 0 }]);
    expect(rows('SELECT user_id FROM email_preferences')).toEqual([{ user_id: rows('SELECT id FROM users WHERE email = ?', 'owner@example.com')[0].id }]);

    // The operator (owner of their own workspace) is unchanged.
    expect(await (await w.api(w.operator, 'GET', '/api/email-preferences')).json()).toMatchObject({ summary: { enabled: true }, tips: { enabled: false } });

    // And back on.
    const back = await w.api(w.owner, 'PUT', '/api/email-preferences', { kind: 'summary', enabled: true });
    expect((await back.json() as any).summary.enabled).toBe(true);
  });

  it('tips are not offered when the instance does not send them (LIFECYCLE_EMAILS_ON), and LIFECYCLE_EMAILS_OFF=tips withdraws them', async () => {
    for (const [env, offered] of [[{}, false], [{ LIFECYCLE_EMAILS_ON: 'tips' }, true], [{ LIFECYCLE_EMAILS_ON: 'tips', LIFECYCLE_EMAILS_OFF: 'tips' }, false]] as const) {
      const w = await billingWorld(env, { stripe: false });
      expect(await (await w.api(w.owner, 'GET', '/api/email-preferences')).json(), JSON.stringify(env)).toMatchObject({ summary: { offered: true, enabled: true }, tips: { offered, enabled: false } });
    }
  });

  it('an admin is offered both, off by default; a member is offered neither and PUT is 403', async () => {
    const w = await billingWorld({ LIFECYCLE_EMAILS_ON: 'tips' }, { stripe: false });
    const admin = await w.addMember(w.owner.workspaceId, 'admin@example.com', 'admin');
    const member = await w.addMember(w.owner.workspaceId, 'member@example.com', 'member');
    expect(await (await w.api(admin, 'GET', '/api/email-preferences')).json()).toEqual({ role: 'admin', summary: { offered: true, enabled: false }, tips: { offered: true, enabled: false } });
    const on = await w.api(admin, 'PUT', '/api/email-preferences', { kind: 'tips', enabled: true });
    expect((await on.json() as any).tips.enabled).toBe(true);

    expect(await (await w.api(member, 'GET', '/api/email-preferences')).json()).toEqual({ role: 'member', summary: { offered: false, enabled: false }, tips: { offered: false, enabled: false } });
    const before = w.db.sqlite.prepare('SELECT count(*) AS n FROM email_preferences').get() as { n: number };
    for (const kind of ['summary', 'tips']) expect((await w.api(member, 'PUT', '/api/email-preferences', { kind, enabled: true })).status).toBe(403);
    expect(w.db.sqlite.prepare('SELECT count(*) AS n FROM email_preferences').get()).toEqual(before);
  });

  it('refuses an invalid body with 400, and other methods with 405', async () => {
    const w = await billingWorld({}, { stripe: false });
    for (const body of [undefined, {}, { kind: 'summary' }, { enabled: true }, { kind: 'other', enabled: true }, { kind: 'summary', enabled: 'yes' }, { kind: 'summary', enabled: 1 }, { kind: ['summary'], enabled: true }, null, 'x']) {
      const res = await w.api(w.owner, 'PUT', '/api/email-preferences', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(w.db.sqlite.prepare('SELECT count(*) AS n FROM email_preferences').get()).toEqual({ n: 0 });
    expect((await w.api(w.owner, 'POST', '/api/email-preferences', { kind: 'summary', enabled: false })).status).toBe(405);
    expect((await w.api(w.owner, 'DELETE', '/api/email-preferences')).status).toBe(405);
  });

  it('needs a signed-in person: 401 without a key', async () => {
    const w = await billingWorld({}, { stripe: false });
    expect((await call(w.env, 'GET', '/api/email-preferences')).status).toBe(401);
    expect((await call(w.env, 'PUT', '/api/email-preferences', { body: { kind: 'summary', enabled: false } })).status).toBe(401);
    expect((await call(w.env, 'GET', '/api/email-preferences', { key: 'not-a-key' })).status).toBe(401);
  });

  it('an API key (not a session) is refused 403', async () => {
    const w = await billingWorld({}, { stripe: false });
    const send = (method: string, path: string, body?: unknown, key = w.owner.token) => call(w.env, method, path, { key, body, headers: w.h(w.owner) });
    const product = await (await send('POST', '/api/access/products', { name: 'A' })).json() as any;
    const principal = await (await send('POST', '/api/access/principals', { name: 'A worker', kind: 'service' })).json() as any;
    const expires_at = Math.floor(Date.now() / 1000) + 3600;
    const grant = await send('POST', '/api/access/grants', { principal_id: principal.id, product_id: product.id, domain: 'mail.example.com', actions: ['resources:read', 'reports:read'], expires_at });
    void grant;
    const credential = await (await send('POST', '/api/access/credentials', { principal_id: principal.id, name: 'CI', expires_at })).json() as any;
    expect(credential.key).toMatch(/^ias_/);
    const get = await send('GET', '/api/email-preferences', undefined, credential.key);
    const put = await send('PUT', '/api/email-preferences', { kind: 'summary', enabled: false }, credential.key);
    expect([get.status, put.status]).toEqual([403, 403]);
    expect(w.db.sqlite.prepare('SELECT count(*) AS n FROM email_preferences').get()).toEqual({ n: 0 });
  });

  it('is 404 when the instance is not hosted', async () => {
    const w = await lifecycleWorld({ MODE: 'selfhost', SAAS_ENABLED: undefined }); vi.restoreAllMocks();
    const tenant = new TenantContext({ env: w.env, workspaceId: WS, role: 'owner', mode: 'selfhost', settings: {} });
    for (const method of ['GET', 'PUT']) {
      const res = await handleEmailPreferences(new Request('https://app.readysetmail.com/api/email-preferences', { method, body: method === 'PUT' ? JSON.stringify({ kind: 'summary', enabled: false }) : undefined }), tenant, { id: w.dana });
      expect(res!.status).toBe(404);
    }
    expect(w.rows('SELECT * FROM email_preferences')).toEqual([]);
  });

  it('a choice in one workspace does not change the same person\'s other workspace', async () => {
    const w = await billingWorld({ LIFECYCLE_EMAILS_ON: 'tips' }, { stripe: false });
    const rows = (q: string, ...p: unknown[]) => w.db.sqlite.prepare(q).all(...p) as any[];
    // The owner is also an owner of the operator's workspace.
    const uid = rows('SELECT id FROM users WHERE email = ?', 'owner@example.com')[0].id;
    w.db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(w.operator.workspaceId, uid);
    const inA = { ...w.owner };
    const inB = { ...w.owner, workspaceId: w.operator.workspaceId };

    const put = await w.api(inA, 'PUT', '/api/email-preferences', { kind: 'tips', enabled: true });
    expect((await put.json() as any).tips.enabled).toBe(true);
    expect((await (await w.api(inB, 'GET', '/api/email-preferences')).json() as any).tips.enabled).toBe(false);
    expect((await (await w.api(inA, 'GET', '/api/email-preferences')).json() as any).tips.enabled).toBe(true);

    await w.api(inB, 'PUT', '/api/email-preferences', { kind: 'summary', enabled: false });
    expect((await (await w.api(inA, 'GET', '/api/email-preferences')).json() as any).summary.enabled).toBe(true);
    expect(rows('SELECT workspace_id, kind, enabled FROM email_preferences ORDER BY workspace_id, kind').sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { workspace_id: w.operator.workspaceId, kind: 'summary', enabled: 0 },
      { workspace_id: w.owner.workspaceId, kind: 'tips', enabled: 1 },
    ]);
  });
});
