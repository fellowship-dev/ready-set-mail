// Where a sign-up came from (docs/analytics.md): `src` and whether the checker's domain came along, read from the website's sign-up
// link into memory only. No id is ever read from the link, and nothing is put in browser storage.
import { beforeEach, describe, expect, it } from 'vitest';
import { captureSignupIntent } from '../src/lib/signup-intent';
import { __resetVisitForTests, signupAnalytics } from '../src/lib/signup-source';

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	__resetVisitForTests();
});

const storedKeys = () => [...Object.keys(localStorage), ...Object.keys(sessionStorage)];

describe('signup source', () => {
	it('sends src and from_checker from the sign-up link, never the domain or an id', () => {
		captureSignupIntent({ pathname: '/signup', search: '?src=checker&domain=example.com&vid=3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e', hash: '' });
		expect(signupAnalytics()).toEqual({ src: 'checker', from_checker: true });
		expect(JSON.stringify(signupAnalytics())).not.toMatch(/example\.com|3f2b8c1e/);
		// The domain carry-over is the existing sign-up intent's; nothing of the source is stored.
		expect(storedKeys().filter((k) => /src|source|vid|visit/i.test(k))).toEqual([]);
	});

	it('a page class without the checker domain; a hash link; an odd value becomes other; no link sends nothing', () => {
		captureSignupIntent({ pathname: '/', search: '', hash: '#/signup?src=pricing' });
		expect(signupAnalytics()).toEqual({ src: 'pricing', from_checker: false });
		captureSignupIntent({ pathname: '/signup', search: '?src=https://evil.example/x', hash: '' });
		expect(signupAnalytics()).toEqual({ src: 'other', from_checker: false });
		captureSignupIntent({ pathname: '/signup', search: '', hash: '' });
		expect(signupAnalytics()).toEqual({ from_checker: false });
		__resetVisitForTests();
		expect(signupAnalytics()).toEqual({});
	});
});
