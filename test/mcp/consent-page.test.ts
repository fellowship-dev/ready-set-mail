import { describe, expect, it } from 'vitest';
import { ACTION_COPY, escape, EXPIRY_CHOICES, PAGE_CSP, pageHeaders, renderConsentPage, renderConsentProblem, renderSignedOutPage, type ConsentModel } from '../../src/mcp/consent';
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

describe('consent page', () => {
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
  expect(text).toContain('It calls itself \u201cClaude\u201d. That is its own description.');
  expect(text).toContain('Access goes to claude.ai');
  expect(text).toContain('You are signed in as owner@example.com');
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
  // The two read permissions a first answer needs start ticked; nothing that adds domains does.
  expect(html).toContain('value="resources:read" checked');
  expect(html).toContain('value="reports:read" checked');
  expect(html).not.toContain('value="domains:manage" checked');
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
  expect(text).toContain('It calls itself \u201cClaude\u201d. The app chose that name, so it may not be who it says.');
  expect(text).toContain('Access goes to evil.example . Allow only if that is the app you are using right now.');
  expect(html).not.toMatch(/<input[^>]* checked/);
 });

 it('says what is true when the name was withheld, and "It gave no name." only when there was none', () => {
  const withheld = visible(renderConsentPage(model({ client: { lead: 'client.example', calledItself: null, nameWithheld: true, redirectHost: 'client.example', loopback: false } })));
  expect(withheld).toContain('It used the name of a well-known app, so the name is not shown: only the address below is known.');
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

 it('preselects the only domain when there is exactly one, and explains an empty portfolio', () => {
  const one = renderConsentPage(model({ workspaces: [{ id: 'w', name: 'Solo', choices: [{ value: '{"workspaceId":"w","domain":"solo.example"}', domain: 'solo.example' }] }] }));
  expect(one).toMatch(/name="selection" value="[^"]+" checked/);
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
  expect(text).not.toContain('the app chose that name');
  expect(visible(renderConsentPage(model({ client: { lead: 'cursor.com', calledItself: 'Cursor', redirectHost: 'cursor.com', loopback: false } })))).toContain('The app chose that name');
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
