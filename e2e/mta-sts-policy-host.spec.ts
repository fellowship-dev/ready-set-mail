// A request for `mta-sts.<domain>`, against the real Worker (scripts/e2e-devbox.sh). wrangler.jsonc keeps main's `assets.run_worker_first` path list, so what
// answers depends on whether the path is in it: the paths in the list reach the Worker, which answers a policy host with a 404 (or the policy), and every other
// path is answered by the static assets first (the dashboard's single-page fallback). The Host header is what a sender's HTTPS request carries; the Worker is
// reached on its own address. On the hosted service only `*/.well-known/mta-sts.txt` is routed to the Worker, so those other paths never get here (docs/mta-sts.md).
import { test, expect } from '@playwright/test';
import { runSql } from './support/db';

test.use({ trace: 'off', video: 'off' });

const host = { host: 'mta-sts.policy-host.example' };
const get = (request: any, path: string) => request.get(path, { headers: host, maxRedirects: 0, failOnStatusCode: false });

// The paths run_worker_first lists: they reach the Worker, and a policy host there is a 404 and never the dashboard.
for (const path of ['/api/domains', '/llms.txt', '/oauth/token', '/.well-known/other']) {
	test(`mta-sts.<domain>${path} reaches the Worker and is a 404, never the dashboard`, async ({ request }) => {
		const res = await get(request, path);
		expect(res.status()).toBe(404);
		expect(await res.text()).not.toMatch(/<html|<script|Ready Set Mail/i);
	});
}

test('the policy path reaches the Worker (it is in run_worker_first): a domain with no MTA-STS answers 404 from the Worker, not the dashboard', async ({ request }) => {
	const res = await get(request, '/.well-known/mta-sts.txt');
	expect(res.status()).toBe(404);
	expect(await res.text()).toBe('MTA-STS not configured for this domain');
});

test('a domain with MTA-STS on: the policy path answers 200 with the policy from the Worker, GET and HEAD, never cached; POST is a 404', async ({ request }) => {
	runSql(`INSERT OR IGNORE INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (9001, 'ws_default', 'policy-live.example', 'rua@reports.e2e.test', 'txt');
INSERT OR REPLACE INTO mta_sts_config (domain_id, workspace_id, enabled, mode, mx_hosts, policy_id, state) VALUES (9001, 'ws_default', 1, 'testing', 'mx.policy-live.example', 'p1', 'active');`);
	const h = { host: 'mta-sts.policy-live.example' };
	const res = await request.get('/.well-known/mta-sts.txt', { headers: h, maxRedirects: 0, failOnStatusCode: false });
	expect(res.status()).toBe(200);
	expect(res.headers()['content-type']).toMatch(/^text\/plain/);
	expect(res.headers()['cache-control']).toBe('no-store');
	expect(await res.text()).toBe('version: STSv1\nmode: testing\nmx: mx.policy-live.example\nmax_age: 86400\n');
	expect((await request.head('/.well-known/mta-sts.txt', { headers: h, maxRedirects: 0, failOnStatusCode: false })).status()).toBe(200);
	expect((await request.post('/.well-known/mta-sts.txt', { headers: h, maxRedirects: 0, failOnStatusCode: false })).status()).toBe(404);
});

test('POST to the policy path is a 404 from the Worker', async ({ request }) => {
	const res = await request.post('/.well-known/mta-sts.txt', { headers: host, maxRedirects: 0, failOnStatusCode: false });
	expect(res.status()).toBe(404);
	expect(await res.text()).not.toMatch(/<html|<script/i);
});

// Not in run_worker_first: the static assets answer before the Worker, on every host. Said here so nobody believes they 404 locally or on self-host.
for (const path of ['/', '/nope', '/assets/does-not-exist.js']) {
	test(`mta-sts.<domain>${path} is answered by the static assets (the single-page fallback), as it always was`, async ({ request }) => {
		const res = await get(request, path);
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toMatch(/html/);
	});
}

test('the dashboard on its own host is still served', async ({ request }) => {
	const res = await request.get('/', { maxRedirects: 0, failOnStatusCode: false });
	expect(res.status()).toBe(200);
	expect(res.headers()['content-type']).toMatch(/html/);
});
