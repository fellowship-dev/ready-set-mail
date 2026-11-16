// R2 item 5, against the real Worker (scripts/e2e-devbox.sh): a request for `mta-sts.<domain>` answers the policy path and nothing else. Static assets run
// before the Worker unless wrangler.jsonc says run_worker_first, so `/`, `/index.html` and `/assets/...` used to be 200 here. The Host header is what a
// sender's HTTPS request carries; the Worker is reached on its own address.
import { test, expect } from '@playwright/test';

test.use({ trace: 'off', video: 'off' });

for (const path of ['/', '/nope', '/index.html', '/assets/does-not-exist.js', '/api/domains', '/llms.txt', '/oauth/token']) {
	test(`mta-sts.<domain>${path} is a 404 and never the dashboard`, async ({ request }) => {
		const res = await request.get(path, { headers: { host: 'mta-sts.policy-host.example' }, maxRedirects: 0, failOnStatusCode: false });
		expect(res.status()).toBe(404);
		expect(await res.text()).not.toMatch(/<html|<script|Ready Set Mail/i);
	});
}

test('the dashboard on its own host is still served', async ({ request }) => {
	const res = await request.get('/', { maxRedirects: 0, failOnStatusCode: false });
	expect(res.status()).toBe(200);
	expect(res.headers()['content-type']).toMatch(/html/);
});
