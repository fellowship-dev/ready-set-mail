// The MTA-STS page in a real browser, at a phone width and a desktop width. A local `wrangler dev` is self-host and has no
// Cloudflare behind it, so the MTA-STS API is answered by page.route here (a small stateful model of the server, with the
// documented response shape: docs/hosted.md, "MTA-STS") and everything else is the real Worker and dashboard. This proves
// the screens and the order of the flow; test/mta-sts covers the backend, web/test/mta-sts.test.tsx every page state.
//   npx wrangler dev --local --persist-to /tmp/ia-e2e   (build:dashboard first)
//   npx playwright test e2e/mta-sts.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { ensureDomain } from './support/db';
import { signIn } from './support/session';

const DOMAIN = 'example.net';
const TARGET = 'mta-sts-host.readysetmail.com';
const RUA = 'tls-rpt@rua.readysetmail.com';
const now = () => Math.floor(Date.now() / 1000);

type State = 'off' | 'waiting_certificate' | 'testing' | 'enforce';

function server() {
	const s = { state: 'off' as State, certActive: false, reports: [] as unknown[], kept: [] as unknown[] };
	const records = (written: boolean) => [
		{ purpose: 'policy_host', type: 'CNAME', name: `mta-sts.${DOMAIN}`, value: TARGET, proxied: false, written, add_now: false, note: 'DNS only (grey cloud): Cloudflare issues the certificate for this name after the record resolves.' },
		{ purpose: 'tls_rpt', type: 'TXT', name: `_smtp._tls.${DOMAIN}`, value: `v=TLSRPTv1; rua=mailto:${RUA}`, written, add_now: false },
		{ purpose: 'policy_id', type: 'TXT', name: `_mta-sts.${DOMAIN}`, value: s.state === 'off' ? 'v=STSv1; id=YYYYMMDDHHMMSS' : 'v=STSv1; id=20261116155117', written: s.state === 'testing' || s.state === 'enforce', add_now: false },
	];
	const config = () => ({
		enabled: 1, mode: s.state === 'enforce' ? 'enforce' : 'testing', state: s.state === 'waiting_certificate' ? 'waiting_certificate' : 'active', via: 'cloudflare', policy_host: 'saas_hostname',
		mx_hosts: 'mx.example.net', mx_host_list: ['mx.example.net'], policy_id: '20261116155117', max_age: 86400, policy_published_at: s.state === 'waiting_certificate' ? null : now() - 86400,
		mode_changed_at: now() - 86400, left_enforce_at: null, last_checked_at: now() - 30, last_error: null, notice: null, notice_at: null, created_at: now() - 86400, updated_at: now(), domain_id: 1,
	});
	const get = () => {
		if (s.state === 'off') {
			return { available: true, unavailable_reason: 'none', unavailable_message: null, via: 'cloudflare', policy_host: 'saas_hostname', mx_preview: { status: 'ok', hosts: ['mx.example.net'], error: null }, records: records(false), records_problem: null, config: null, policy_host_status: null, summary: null, reports: [], enforce: null, disable: null, max_age: 86400 };
		}
		return {
			available: true, unavailable_reason: 'none', unavailable_message: null, via: 'cloudflare', policy_host: 'saas_hostname', mx_preview: { status: 'ok', hosts: ['mx.example.net'], error: null },
			records: records(true), records_problem: null, config: config(),
			policy_host_status: { kind: 'saas_hostname', hostname: `mta-sts.${DOMAIN}`, route: true, certificate: { status: s.certActive ? 'active' : 'pending', ssl_status: s.certActive ? 'active' : 'pending_validation', active: s.certActive } },
			summary: { total_success: s.reports.length * 50, total_failure: s.reports.length * 4, report_count: s.reports.length, sts_success: s.reports.length * 45, sts_failure: s.reports.length * 3 },
			reports: s.reports,
			enforce: s.state === 'testing' ? { ready: false, allowed: false, reasons: ['In testing for 1 of 7 days: 6 more.', 'No verified TLS report has arrived yet for this policy.'], checks: [
				{ key: 'days', label: '7 days in testing', met: false, reasons: ['In testing for 1 of 7 days: 6 more.'] },
				{ key: 'report', label: 'A report signed by Google or Microsoft about this policy, with successful sessions', met: s.reports.length > 0, reasons: s.reports.length > 0 ? [] : ['No verified TLS report has arrived yet for this policy.'] },
				{ key: 'failures', label: 'No failures in signed reports about this policy in the last 14 days', met: true, reasons: [] },
				{ key: 'mx', label: 'The MX hosts match the policy', met: true, reasons: [] },
				{ key: 'served', label: 'The policy is served', met: true, reasons: [] },
			] } : null,
			served: s.state === 'testing' || s.state === 'enforce' ? { ok: true, checked_at: now() - 30, reason: null, message: null, action: null, url: `https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt` } : null,
			evidence: { rule: 'x', no_reports_note: 'A domain that receives no TLS reports can never switch to enforce.', counted_reports: s.reports.length, uncounted_reports: 0, verifiable: true },
			disable: s.state === 'enforce' ? { allowed: false, after: null, reason: 'Switch to testing first. Senders keep the enforce policy for up to 1 day; you can disable it after that.' } : { allowed: true, after: null, reason: null },
			max_age: 86400,
		};
	};
	return { s, get };
}

async function mock(page: Page, id: number) {
	const m = server();
	await page.route('**/api/hosted/config', (r) => r.fulfill({ json: { enabled: true, reports: true, records: false, mta_sts: true } }));
	await page.route(`**/api/domains/${id}/mta-sts/verify`, (r) => {
		if (m.s.state === 'waiting_certificate') { m.s.certActive = true; m.s.state = 'testing'; }
		return r.fulfill({ json: { ok: true, state: 'active', notice: null, last_error: null, served: { ok: true, checked_at: now(), reason: null, message: null, action: null, url: `https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt` }, checks: [
			{ key: 'policy_host', label: `mta-sts.${DOMAIN} reaches the policy host`, state: 'ok', detail: null },
			{ key: 'certificate', label: 'Certificate for the policy host', state: 'ok', detail: null },
			{ key: 'tls_rpt', label: 'TLS reports are sent to Ready Set Mail', state: 'ok', detail: null },
			{ key: 'policy_id', label: 'The policy id is published', state: 'ok', detail: null },
		] } });
	});
	await page.route(`**/api/domains/${id}/mta-sts`, async (r) => {
		const method = r.request().method();
		if (method === 'POST') { m.s.state = 'waiting_certificate'; return r.fulfill({ status: 201, json: m.get() }); }
		if (method === 'PATCH') {
			const body = r.request().postDataJSON() as { mode?: string };
			if (body.mode === 'testing') m.s.state = 'testing';
			return r.fulfill({ json: { ok: true } });
		}
		if (method === 'DELETE') { m.s.state = 'off'; return r.fulfill({ json: { ok: true, kept: [{ type: 'TXT', name: `_smtp._tls.${DOMAIN}`, reason: 'its content no longer matches what Ready Set Mail wrote' }], operator: 'removed', message: 'Senders that already fetched the policy may keep it for up to 1 day.' } }); }
		return r.fulfill({ json: m.get() });
	});
	return m;
}

const noSideways = async (page: Page, what: string) => {
	const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	expect(over, `${what} scrolls sideways by ${over}px`).toBeLessThanOrEqual(0);
};

for (const width of [375, 1440]) {
	test(`turn on, set up, see the reports, turn off, at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
		await signIn(page);
		const id = await ensureDomain(page, DOMAIN);
		const m = await mock(page, id);

		// The domain page: the DNS tools card says Off and links to Set up.
		await page.goto(`/#/domains/${id}`);
		await page.reload();
		await page.getByRole('button', { name: /DNS tools/ }).click();
		const card = page.getByRole('heading', { name: 'MTA-STS', level: 3 }).locator('xpath=ancestor::div[contains(@class,"rounded")][1]');
		await expect(card.getByText('Off', { exact: true })).toBeVisible();
		await card.getByRole('link', { name: 'Set up' }).click();

		// One page: what it is, the MX hosts now, the exact records, one action.
		await expect(page.getByRole('heading', { name: `MTA-STS for ${DOMAIN}`, level: 1 })).toBeVisible();
		await expect(page.getByText(/asks other mail servers to encrypt delivery/i)).toBeVisible();
		await expect(page.getByRole('list', { name: 'MX hosts' })).toContainText('mx.example.net');
		// The records Cloudflare writes sit behind "Show records".
		await page.getByRole('button', { name: 'Show records' }).click();
		const records = page.getByRole('list', { name: 'Records' });
		await expect(records).toContainText(`mta-sts.${DOMAIN}`);
		await expect(records).toContainText(TARGET);
		await expect(records).toContainText(`v=TLSRPTv1; rua=mailto:${RUA}`);
		await expect(page.getByText(/It starts in testing mode/)).toBeVisible();
		await noSideways(page, 'the page before it is on');
		await expect(page.getByRole('button', { name: /^(Turn on|Enable)/ })).toHaveCount(1);

		// Turn on: the same page says Setting up and asks for the certificate.
		await page.getByRole('button', { name: 'Turn on in testing mode' }).click();
		await expect(page.getByText('Waiting for the certificate. This takes a few minutes.')).toBeVisible();
		await expect(page.getByText('Setting up', { exact: true }).first()).toBeVisible();
		await noSideways(page, 'the page while setting up');

		// Check now: every check in place, and Testing, with no report yet.
		await page.getByRole('button', { name: 'Check now' }).click();
		await expect(page.getByText('Testing: mail is delivered as before, and senders that send TLS reports tell you about problems.')).toBeVisible();
		await expect(page.getByText(`Served at https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt`)).toBeVisible();
		await expect(page.getByText(/^Checked \d{4}-\d\d-\d\d \d\d:\d\d UTC$/)).toBeVisible(); // when it was fetched
		await expect(page.getByRole('button', { name: 'Check now' })).toHaveCount(1); // served can go stale: Check now stays, small
		await expect(page.getByText('No signed TLS report yet')).toBeVisible();
		await expect(page.getByText('Senders usually send one a day after they deliver mail to you.')).toBeVisible();
		const enforce = page.getByRole('button', { name: 'Switch to enforce' });
		await expect(enforce).toBeDisabled();
		const rule = page.getByRole('list', { name: 'What enforce needs' });
		await expect(rule.getByText('In testing for 1 of 7 days: 6 more.')).toBeVisible();
		await expect(rule.getByText('A report signed by Google or Microsoft about this policy, with successful sessions')).toBeVisible();
		await expect(rule.getByText('Met:')).toHaveCount(3);
		await expect(rule.getByText('Missing:')).toHaveCount(2);
		await expect(page.getByText('A domain that receives no TLS reports can never switch to enforce.')).toBeVisible();
		// FOLD-01: the primary action is on the first screen
		const box = await enforce.boundingBox();
		expect(box!.y + box!.height, 'Switch to enforce is below the first screen').toBeLessThanOrEqual(page.viewportSize()!.height);
		await noSideways(page, 'the page in testing');

		// A sender's first report arrives: it is on the page.
		m.s.reports = [{ id: 1, reporter: 'Google', period_start: now() - 2 * 86400, period_end: now() - 86400, received_at: now() - 3600, successful_sessions: 50, failed_sessions: 4, sts_successful_sessions: 45, sts_failed_sessions: 3, failure_types: ['certificate-expired'] }];
		await page.reload();
		const reports = page.getByTestId('tls-reports');
		await expect(reports).toContainText('Google');
		await expect(reports).toContainText('45');
		await expect(reports).toContainText("your mail server's certificate has expired");
		await noSideways(page, 'the page with a report');

		// Turn off, in testing: asked first, then what was removed and what was kept.
		await page.getByRole('button', { name: 'Turn off MTA-STS' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toContainText('may keep it for up to 1 day');
		await dialog.getByRole('button', { name: 'Turn off' }).click();
		await expect(page.getByRole('heading', { name: 'MTA-STS is off' })).toBeVisible();
		await expect(page.getByText('Kept, because you changed them')).toBeVisible();
		await expect(page.getByText('Senders that already fetched the policy may keep it for up to 1 day.')).toBeVisible();
		await noSideways(page, 'the result of turning off');
	});
}

test('not available: the server\'s sentence and no button', async ({ page }) => {
	await signIn(page);
	const id = await ensureDomain(page, DOMAIN);
	await page.route(`**/api/domains/${id}/mta-sts`, (r) => r.fulfill({ json: { available: false, unavailable_reason: 'not_configured', unavailable_message: 'MTA-STS is not available on this service yet: the operator has not set up policy hosting.', via: null, policy_host: null, mx_preview: { status: 'ok', hosts: [], error: null }, records: [], records_problem: null, config: null, policy_host_status: null, summary: null, reports: [], enforce: null, disable: null, max_age: 86400 } }));
	await page.goto(`/#/domains/${id}/mta-sts`);
	await expect(page.getByText('MTA-STS is not available on this service yet: the operator has not set up policy hosting.')).toBeVisible();
	await expect(page.getByRole('button', { name: /Turn on/ })).toHaveCount(0);
});
