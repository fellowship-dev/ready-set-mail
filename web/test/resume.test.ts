// Signing in on the way to an app's approval page (web/src/lib/resume.ts): the request is carried through sign-in and the person returns to it. Only this
// server's own authorization endpoint may ever be a target.
import { beforeEach, describe, expect, it } from 'vitest';
import { captureResume, safeResumePath, takeResume } from '../src/lib/resume';

const ORIGIN = 'https://app.example';
const good = '/oauth/authorize?client_id=https%3A%2F%2Fcimd.example%2Fc.json&redirect_uri=https%3A%2F%2Fcimd.example%2Fcb&state=x';

describe('safeResumePath', () => {
	it('accepts the authorization endpoint with its query, and nothing else', () => {
		expect(safeResumePath(good, ORIGIN)).toBe(good);
		expect(safeResumePath('/oauth/authorize?a=b&c=%2F%2Fevil.example', ORIGIN)).toBe('/oauth/authorize?a=b&c=%2F%2Fevil.example');
	});
	it.each([
		['an empty value', ''], ['no query', '/oauth/authorize'], ['another path', '/oauth/token?x=1'], ['the dashboard', '/#/settings'],
		['a protocol-relative address', '//evil.example/oauth/authorize?x=1'], ['an absolute address', 'https://evil.example/oauth/authorize?x=1'],
		['a different scheme', 'javascript:alert(1)'], ['a backslash trick', '/\\evil.example/oauth/authorize?x=1'], ['a tab trick', '/\t/evil.example'],
		['a path that only looks like it', '/oauth/authorize/../token?x=1'], ['a path below it', '/oauth/authorize/x?y=1'], ['a fragment', '/oauth/authorize?x=1#frag'],
		['a very long one', `/oauth/authorize?${'a'.repeat(4000)}`],
	])('refuses %s', (_what, value) => expect(safeResumePath(value, ORIGIN)).toBeNull());
	it('refuses null and undefined', () => {
		expect(safeResumePath(null, ORIGIN)).toBeNull();
		expect(safeResumePath(undefined, ORIGIN)).toBeNull();
	});
});

describe('captureResume and takeResume', () => {
	beforeEach(() => {
		sessionStorage.clear();
		window.history.replaceState(null, '', '/');
	});
	it('keeps the request for the tab, takes it out of the address bar, and gives it back once', () => {
		window.history.replaceState(null, '', `/?continue=${encodeURIComponent(good)}#/`);
		captureResume();
		expect(window.location.search).toBe('');
		expect(window.location.hash).toBe('#/');
		expect(takeResume()).toBe(good);
		expect(takeResume()).toBeNull();
	});
	it('ignores a request that is not an authorization request, and still clears the address bar', () => {
		window.history.replaceState(null, '', `/?continue=${encodeURIComponent('https://evil.example/')}#/`);
		captureResume();
		expect(window.location.search).toBe('');
		expect(takeResume()).toBeNull();
	});
	it('keeps other query parameters', () => {
		window.history.replaceState(null, '', `/?utm=1&continue=${encodeURIComponent(good)}#/`);
		captureResume();
		expect(window.location.search).toBe('?utm=1');
	});
	it('does nothing without a continue parameter', () => {
		window.history.replaceState(null, '', '/?x=1#/');
		sessionStorage.setItem('rsm.resume', good);
		captureResume();
		expect(window.location.search).toBe('?x=1');
		expect(takeResume()).toBe(good);
	});
	it('forgets a stored value that is not safe', () => {
		sessionStorage.setItem('rsm.resume', 'https://evil.example/oauth/authorize?x=1');
		expect(takeResume()).toBeNull();
		expect(sessionStorage.getItem('rsm.resume')).toBeNull();
	});
});
