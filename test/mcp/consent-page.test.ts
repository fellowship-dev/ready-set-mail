import { describe, expect, it } from 'vitest';
import { ACTION_COPY, escape, EXPIRY_CHOICES, PAGE_CSP, pageHeaders, renderApprovalLimit, renderConsentPage, BAR_HEIGHT, renderConsentProblem, renderSignedOutPage, type ConsentModel } from '../../src/mcp/consent';
import { ACCESS_ACTIONS } from '../../src/access/grant';

const attack = '"><img src=x onerror=alert(1)><script>alert(1)</script>';
const model = (over: Partial<ConsentModel> = {}): ConsentModel => ({
 client: { lead: 'claude.ai', calledItself: 'Claude', publisher: 'claude.ai', redirectHost: 'claude.ai', loopback: false },
 account: 'owner@example.com',
 handle: 'handle-123',
 workspaces: [{ id: 'ws_default', name: 'Acme Agency', choices: [
  { value: JSON.stringify({ workspaceId: 'ws_default', domain: 'acme.com' }), domain: 'acme.com' },
  { value: JSON.stringify({ workspaceId: 'ws_default', productId: 'prod_1', domain: 'acme.com' }), domain: 'acme.com', product: 'Receipts' },
 ] }],
 now: Date.UTC(2026, 10, 13) / 1000,
 ...over,
});
/** What a person reads: markup and attribute values removed. */
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

/** The words a person reads before the first choice (the first domain checkbox, or the first control of any kind). */
const wordsAboveFirstChoice = (html: string) => {
 const body = html.slice(html.indexOf('<main'));
 const first = body.search(/<input type="checkbox"|<select|<input type="text"/);
 return visible(body.slice(0, first)).trim().split(' ').filter(Boolean).length;
};
const long = { lead: 'x', calledItself: 'A Rather Long App Name Here', redirectHost: 'x', loopback: false } as const;
const kinds: Array<[string, ConsentModel['client']]> = [
 ['a self-registered web app (https redirect)', { ...long, lead: 'agent.example.net', redirectHost: 'agent.example.net' }],
 ['a self-registered app on this computer (loopback redirect)', { ...long, lead: 'An app on this computer', redirectHost: '127.0.0.1', loopback: true }],
 ['a client-document app (publisher set)', { ...long, lead: 'agent.example.net', publisher: 'agent.example.net', redirectHost: 'agent.example.net' }],
 ['an app whose name was withheld', { lead: 'An app on this computer', calledItself: null, nameWithheld: true, redirectHost: '127.0.0.1', loopback: true }],
];

describe('consent page', () => {
 it.each(kinds)('for %s the first choice comes before the long notices, with at most 60 words above it', (_name, client) => {
  const html = renderConsentPage(model({ client }));
  expect(wordsAboveFirstChoice(html)).toBeLessThanOrEqual(60);
  const text = visible(html);
  const firstChoice = text.indexOf('Nothing is ticked yet');
  for (const later of ['Signed in as owner@example.com', 'You can revoke access sooner in Settings, under Agents', 'It can never do these']) {
   expect(text).toContain(later);
   expect(text.indexOf(later)).toBeGreaterThan(firstChoice);
  }
  // what the person needs to know about the app is still above the choices
  expect(text.indexOf('Access goes to')).toBeLessThan(firstChoice);
  expect(text.indexOf(client.publisher ? 'Published by' : client.nameWithheld ? 'well-known app' : 'Not verified')).toBeLessThan(firstChoice);
  if (client.loopback) {
   expect(text.indexOf('This sends access to an app on your own computer.')).toBeGreaterThan(text.indexOf('Give itself more access'));
   expect(text.indexOf('This sends access to an app on your own computer.')).toBeLessThan(text.indexOf('Allow access'));
  }
 });

 it('the notice about an app that is not verified is on the page before the buttons, after the choices', () => {
  const text = visible(renderConsentPage(model({ client: { ...long, lead: 'agent.example.net', redirectHost: 'agent.example.net' } })));
  expect(text.indexOf('Allow only if this is the app you are using right now.')).toBeGreaterThan(text.indexOf('Give itself more access'));
  expect(visible(renderConsentPage(model()))).not.toContain('Allow only if');
 });

 it('escapes client, workspace, domain, product and account values everywhere they appear', () => {
  const html = renderConsentPage(model({
   client: { lead: attack, calledItself: attack, publisher: attack, redirectHost: attack, loopback: true },
   account: attack,
   handle: attack,
   workspaces: [{ id: attack, name: attack, choices: [{ value: JSON.stringify({ workspaceId: attack, domain: attack }), domain: attack, product: attack }] }],
  }));
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<img/i);
  expect(html).not.toMatch(/"><img/);
  expect(html).toContain(escape(attack));
  // Every attribute value stays inside its quotes: no quote from the attack closes one.
  for (const tag of html.match(/<[^>]+>/g) ?? []) expect(tag.replace(/"[^"]*"/g, '""')).not.toMatch(/\son\w+=/i);
 });

 it('names workspaces and domains in plain text and keeps raw ids out of what people read', () => {
  const html = renderConsentPage(model());
  const text = visible(html);
  expect(text).toContain('Acme Agency');
  expect(text).toContain('acme.com');
  expect(text).toContain('Only for Receipts');
  expect(text).not.toContain('ws_default');
  expect(text).not.toContain('prod_1');
  expect(text).toContain('Allow claude.ai to work with your domains?');
  expect(text).toContain('Published by claude.ai');
  expect(text).toContain('It calls itself \u201cClaude\u201d.');
  expect(text).toContain('Access goes to claude.ai');
  expect(text).toContain('Signed in as owner@example.com');
 });

 it('describes each permission in plain words with the raw scope as secondary text, and never offers access management', () => {
  const html = renderConsentPage(model());
  for (const action of ACCESS_ACTIONS.filter(a => a !== 'access:manage')) {
   const copy = ACTION_COPY[action as keyof typeof ACTION_COPY];
   expect(html).toContain(`value="${action}"`);
   expect(html).toContain(copy.label);
   expect(html).toContain(`<span class="scope">${action}</span>`);
  }
  expect(html).not.toContain('access:manage');
  expect(html).not.toMatch(/<input[^>]* checked/);
 });

 it('ticks nothing for any app, verified or not, with one domain or many, and says so before the choices', () => {
  const verified = model({ workspaces: [{ id: 'w', name: 'Solo', choices: [{ value: '{"workspaceId":"w","domain":"solo.example"}', domain: 'solo.example' }] }] });
  const registered = model({ ...verified, client: { lead: 'app.example', calledItself: 'My Helper', redirectHost: 'app.example', loopback: false } });
  for (const m of [model(), verified, registered]) {
   const html = renderConsentPage(m);
   expect(html).not.toMatch(/<input[^>]* checked/);
   expect(html.match(/<input type="checkbox"/g)!.length).toBeGreaterThan(6);
   const text = visible(html);
   expect(text).toContain('Nothing is ticked yet: it gets only what you tick, until the date you pick.');
   // the sentence comes before the first choice
   expect(text.indexOf('Nothing is ticked yet')).toBeLessThan(text.indexOf('See the domains you select'));
  }
 });

 it('keeps a focused control out from under the bar that stays at the bottom: scroll padding at least the bar is tall', () => {
  const html = renderConsentPage(model());
  expect(html).toContain('--bar:69px');
  expect(html).toMatch(/html\{scroll-padding-bottom:calc\(var\(--bar\) \+ 1rem\)\}/);
  // the bar is one button row of 44px with 12px above and below, plus its border
  expect(BAR_HEIGHT).toBe(12 + 44 + 12 + 1);
  // the content keeps the bar's height clear at the bottom, and a focused row's whole label (it can wrap to 160px at 375) is scrolled clear of the bar
  expect(html).toMatch(/\.wrap\{[^}]*padding:40px 16px var\(--bar\)\}/);
  expect(html).toMatch(/\.option input\{[^}]*scroll-margin-bottom:9rem\}/);
 });

 it('says plainly which limit was reached and what to do, with a way to the list of apps', () => {
  const html = renderApprovalLimit('You have approved 20 apps in the last 24 hours, which is the most one person can approve in a day. Try again tomorrow.');
  expect(visible(html)).toContain('Try again tomorrow.');
  expect(visible(html)).toContain('Nothing was shared.');
  expect(html).toContain('href="/#/agents"');
  expect(html).not.toMatch(/<script/i);
 });

 it('states when access ends, as dates, with 7 days preselected and nothing beyond 30', () => {
  const html = renderConsentPage(model());
  expect(EXPIRY_CHOICES).toEqual([1, 7, 14, 30]);
  expect(html).toContain('<option value="7" selected>7 days, until 20 November 2026</option>');
  expect(html).toContain('<option value="30">30 days, until 13 December 2026</option>');
  expect(html).toContain('Dates are in UTC');
 });

 it('says what an agent can never do and offers a clear way to refuse', () => {
  const text = visible(renderConsentPage(model()));
  for (const line of ['Change your DNS records', 'Tighten your DMARC policy', 'Send email or invite people', 'Give itself more access']) expect(text).toContain(line);
  const html = renderConsentPage(model());
  expect(html).toContain('<button class="button primary" type="submit" name="decision" value="allow">Allow access</button>');
  expect(html).toContain('name="decision" value="deny" formnovalidate>Don\'t allow</button>');
 });

 it('warns about unverified self-registered clients and local redirects', () => {
  const text = visible(renderConsentPage(model({ client: { lead: 'An app on this computer', calledItself: 'Totally Claude', redirectHost: '127.0.0.1', loopback: true } })));
  expect(text).toContain('Not verified:');
  expect(text).toContain('This sends access to an app on your own computer.');
  // after the choices, before the buttons
  expect(text.indexOf('This sends access')).toBeGreaterThan(text.indexOf('Give itself more access'));
 });

 it('never leads with a self-registered name: the address first, the name as what it calls itself, nothing pre-ticked', () => {
  const html = renderConsentPage(model({
   client: { lead: 'evil.example', calledItself: 'Claude', redirectHost: 'evil.example', loopback: false },
   workspaces: [{ id: 'w', name: 'Solo', choices: [{ value: '{"workspaceId":"w","domain":"solo.example"}', domain: 'solo.example' }] }],
  }));
  expect(html).toContain('<h1>Allow the app at evil.example to work with your domains?</h1>');
  expect(html).toContain('<title>An app is asking for access · Ready Set Mail</title>');
  expect(html).not.toMatch(/<h1>[^<]*Claude/);
  const text = visible(html);
  expect(text).toContain('Not verified: nobody has checked who this app is.');
  expect(text).toContain('It calls itself \u201cClaude\u201d: it may not be who it says.');
  expect(text).toContain('Access goes to evil.example');
  expect(text).toContain('Allow only if this is the app you are using right now.');
  expect(html).not.toMatch(/<input[^>]* checked/);
 });

 it('says what is true when the name was withheld, and "It gave no name." only when there was none', () => {
  const withheld = visible(renderConsentPage(model({ client: { lead: 'client.example', calledItself: null, nameWithheld: true, redirectHost: 'client.example', loopback: false } })));
  expect(withheld).toContain('It used the name of a well-known app, so its name is not shown.');
  expect(withheld).not.toContain('It gave no name.');
  const none = visible(renderConsentPage(model({ client: { lead: 'client.example', calledItself: null, redirectHost: 'client.example', loopback: false } })));
  expect(none).toContain('It gave no name.');
  expect(none).not.toContain('well-known app');
 });

 it('an app on this computer is called that, not by an address', () => {
  const html = renderConsentPage(model({ client: { lead: 'An app on this computer', calledItself: null, redirectHost: '127.0.0.1', loopback: true } }));
  expect(html).toContain('<h1>Allow an app on this computer to work with your domains?</h1>');
  expect(visible(html)).toContain('It gave no name.');
 });

 it('the buttons sit in a bar that stays at the bottom of the screen, so Allow access is always in reach', () => {
  const html = renderConsentPage(model());
  expect(html).toMatch(/\.bar\{position:sticky;bottom:0/);
  expect(html).toMatch(/<div class="bar"><button class="button primary" type="submit" name="decision" value="allow">Allow access<\/button>/);
 });

 it('says changes are made in the dashboard or at the DNS provider, and makes form controls 44px on touch screens', () => {
  const html = renderConsentPage(model());
  expect(visible(html)).toContain('You make those changes yourself, in the dashboard or at your DNS provider.');
  expect(html).toContain('@media (pointer:coarse){select,input[type=text]{height:44px}}');
 });

 it('explains an empty portfolio', () => {
  const none = visible(renderConsentPage(model({ workspaces: [{ id: 'w', name: 'Empty', choices: [] }] })));
  expect(none).toContain('You have no domains yet.');
 });

 it('ships no scripts and the page CSP allows none', () => {
  for (const html of [renderConsentPage(model()), renderSignedOutPage('signed_out'), renderSignedOutPage('unverified'), renderConsentProblem('x')]) {
   expect(html).not.toMatch(/<script/i);
   expect(html).not.toMatch(/\son[a-z]+=/i);
   expect(html).toContain('<title>');
   expect(html).toContain('prefers-color-scheme:dark');
   expect(html).toContain('Geist Variable');
   expect(html).not.toMatch(/gradient/i);
   expect(html).toContain('viewBox="0 0 1526 347" role="img" aria-label="Ready Set Mail"'); // the logo lockup
  }
  expect(PAGE_CSP).not.toContain('script-src');
  expect(PAGE_CSP).toContain("default-src 'none'");
  expect(PAGE_CSP).toContain("frame-ancestors 'none'");
  const headers = pageHeaders({ 'Set-Cookie': 'consent=1' });
  expect(headers.get('Content-Security-Policy')).toBe(PAGE_CSP);
  expect(headers.get('Set-Cookie')).toBe('consent=1');
  expect(headers.get('Cache-Control')).toBe('no-store');
 });

 it('signed-out and problem pages are plain and escape the message', () => {
  expect(visible(renderSignedOutPage('signed_out'))).toContain('Sign in to continue');
  // The request is carried through sign-in as a query value, escaped: a person is sent back to the approval page.
  const resumed = renderSignedOutPage('signed_out', '/oauth/authorize?client_id=x&state="><b>');
  expect(resumed).toContain('href="/?continue=%2Foauth%2Fauthorize%3Fclient_id%3Dx%26state%3D%22%3E%3Cb%3E#/">Sign in and continue</a>');
  expect(visible(renderSignedOutPage('unverified'))).toContain('Confirm your email first');
  const problem = renderConsentProblem(attack);
  expect(problem).not.toMatch(/<script|<img/i);
  expect(visible(problem)).toContain('Nothing was shared.');
 });
});

describe('consent page wording that names the product', () => {
 it('names the Settings section that exists (Settings, under Agents) and no other', () => {
  const text = visible(renderConsentPage(model()));
  expect(text).toContain('You can revoke access sooner in Settings, under Agents.');
  expect(text).not.toContain('Agents and product access');
 });
 it('an app that gave no name is shown as having given none, not as a name it chose', () => {
  const text = visible(renderConsentPage(model({ client: { lead: 'client.example', calledItself: null, redirectHost: 'client.example', loopback: false } })));
  expect(text).toContain('It gave no name.');
  expect(text).toContain('Not verified: nobody has checked who this app is.');
  expect(text).not.toContain('it may not be who it says');
  expect(visible(renderConsentPage(model({ client: { lead: 'cursor.com', calledItself: 'Cursor', redirectHost: 'cursor.com', loopback: false } })))).toContain('it may not be who it says');
 });
});

describe('the page for a link that cannot go on', () => {
 it.each([
  ['Invalid client_id', /doesn't recognise this app/], ['client_id is required', /doesn't recognise this app/],
  ['Invalid redirect URI', /did not register/], ['This authorization expired or was already used; start again', /has expired/],
  ['This authorization was not started in this browser; start again', /has expired/], ['PKCE code_challenge is required', /incomplete/], [undefined, /incomplete/],
 ])('%s', async (description, title) => {
  const { authorizationProblem } = await import('../../src/mcp/consent');
  const html = renderConsentProblem('', authorizationProblem(description));
  const text = visible(html);
  expect(text).toMatch(title);
  expect(text).toMatch(/nothing was shared/i);
  expect(html).toContain('<a class="button primary" href="/#/agents">Open Agents</a>');
  expect(html).not.toMatch(/<script/i);
  // the library's words are never shown
  expect(text).not.toMatch(/PKCE|code_challenge|client_id|redirect URI/);
 });
});
