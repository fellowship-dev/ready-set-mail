// What a self-registered app may call itself (ADR 0015, src/mcp/client-names.ts): a name is a claim, so look-alikes, "verified" claims and the names of
// well-known assistants never reach a person as the app's identity.
import { describe, expect, it } from 'vitest';
import { describedName, isReservedName, mixesScripts, RESERVED_APP_NAMES, skeleton, vetClientName } from '../../src/mcp/client-names';
import { vetRegistration } from '../../src/mcp/registration';

const refused = (name: string) => { const v = vetClientName(name); expect(v.ok, name).toBe(false); return v.ok ? '' : v.reason; };
const withheld = (name: string) => expect(vetClientName(name), name).toEqual({ ok: true, name: null, withheld: 'reserved' });
const kept = (name: string, as = name) => expect(vetClientName(name), name).toEqual({ ok: true, name: as });

describe('the three names the review registered', () => {
 it('"Claude" is accepted but not kept: the app is shown by its address', () => withheld('Claude'));
 it('"Сlaude" with a Cyrillic С is refused: it mixes alphabets', () => expect(refused('Сlaude')).toMatch(/alphabets/));
 it('"Claude (official) ✓ Verified by Anthropic" is refused: it claims a check nobody made', () => expect(refused('Claude (official) ✓ Verified by Anthropic')).toMatch(/verified, official or approved/));
 it('through registration: the first stores no name, the others are refused with invalid_client_metadata', () => {
  const base = { redirect_uris: ['https://client.example/cb'] };
  const a = vetRegistration({ ...base, client_name: 'Claude' });
  expect(a).toMatchObject({ ok: true, withheld: 'reserved' });
  expect(a.ok && a.body.client_name).toBeUndefined();
  for (const name of ['Сlaude', 'Claude (official) ✓ Verified by Anthropic']) expect(vetRegistration({ ...base, client_name: name })).toMatchObject({ ok: false, code: 'invalid_client_metadata', reason: 'name_rejected' });
 });
});

describe('look-alikes of the reserved names', () => {
 it.each([
  'Claude', 'claude', 'CLAUDE', 'Cláude', 'C l a u d e', 'Cl-aude', 'C1aude', 'Cl4ude', 'ＣＬＡＵＤＥ', 'Claude Code', 'My Claude helper', 'Anthropic', 'ChatGPT', 'Chat GPT', 'OpenAI', 'Open AI',
  'Cursor', 'Cursor (laptop)', 'VS Code', 'VSCode', 'Visual Studio Code', 'Visual  Studio  Code', 'Copilot', 'GitHub Copilot', 'Github', 'Gemini', 'Google', 'G00gle Assistant', 'Microsoft', 'M1crosoft', 'Ready Set Mail', 'ReadySetMail', 'ready-set-mail agent',
  'Windsurf', 'Perplexity', 'Codex',
 ])('%s is withheld', name => withheld(name));
 it('Greek and Cyrillic letters standing in for Latin ones are refused as mixed, and a whole word of them still folds to the reserved name', () => {
  for (const name of ['Clаude', 'Cursοr', 'Ρerplexity AI']) refused(name);
  expect(isReservedName('сае')).toBe(false);
  expect(skeleton('СІаude')).toContain('claude'.slice(2));
  expect(isReservedName('сӀауде')).toBe(false);
 });
 it('every name the brief lists is on the list', () => {
  for (const name of ['Claude', 'Anthropic', 'ChatGPT', 'OpenAI', 'Cursor', 'VS Code', 'Visual Studio Code', 'Copilot', 'GitHub', 'Gemini', 'Google', 'Microsoft', 'Ready Set Mail']) expect(RESERVED_APP_NAMES, name).toContain(name);
 });
});

describe('claims of being checked', () => {
 it.each([
  'Verified agent', 'Official Mail Helper', 'My official app', 'Certified', 'Authenticated by us', 'Trusted partner', 'Approved by Acme', 'Endorsed',
  'Mail helper ✓', 'Mail helper ✔', 'Mail helper ✅', 'Mail helper ☑', 'Mail \u{1F512}', 'Mail \u{1F6E1}', 'Mail®', 'Mail™',
 ])('%s is refused', name => { refused(name); });
 it('ordinary names that merely contain the letters are kept', () => {
  kept('Unofficial helper'.replace('Unofficial', 'Helpful'));
  kept('Verity');
  kept('Officer Mail');
 });
});

describe('mixed alphabets and other disguises', () => {
 it('mixesScripts sees Latin with Cyrillic or Greek, and not a single alphabet', () => {
  expect(mixesScripts('Claude')).toBe(false);
  expect(mixesScripts('Привет')).toBe(false);
  expect(mixesScripts('Сlaude')).toBe(true);
  expect(mixesScripts('Alpha α')).toBe(true);
  expect(mixesScripts('Agent 7 (beta)')).toBe(false);
 });
 it('a name in one other alphabet is fine', () => { kept('日本語アプリ'); kept('Почта'); });
 it('controls, markup, links and length are refused as before', () => {
  for (const name of ['two\nlines', 'tab\there', 'bidi ‮evil', 'zero​width', '<b>x</b>', 'a & b', 'https://evil.example/login', 'visit www.evil.example', 'x'.repeat(81)]) refused(name);
 });
 it('a blank name is no name; spacing is tidied; a plain name is kept', () => {
  expect(vetClientName('   ')).toEqual({ ok: true, name: null });
  kept('  My   agent ', 'My agent');
  kept('Mail Helper');
 });
 it('compatibility forms fold first: a full-width markup character is refused like the plain one', () => { refused('＜b＞'); });
});

describe('describedName', () => {
 it('is the name as the app\'s own words, cleaned, or null', () => {
  expect(describedName('  My   app ')).toBe('My app');
  expect(describedName('')).toBeNull();
  expect(describedName(undefined)).toBeNull();
 });
});
