// A TLS report that was not signed (no Authentication-Results from the receiving server: a local `wrangler dev` has none) must not unlock enforce
// (RFC 8460 section 3: reports lacking a valid DKIM signature by the reporting domain "MUST be ignored by the recipient"). The report is delivered through the
// Worker's real email handler (wrangler dev's /cdn-cgi/handler/email) for a domain that has MTA-STS on, seven days in testing and a policy that is served:
// it is stored and shown, labelled as not counted, and the enforce gate still says no.
import { expect, test } from '@playwright/test';
import { ensureDomain, runSql } from './support/db';
import { signIn } from './support/session';

const DOMAIN = 'tls-e2e.example';
const DAY = 86400;

test('an unsigned TLS report is shown but never unlocks enforce', async ({ page, baseURL }) => {
	await signIn(page);
	const id = await ensureDomain(page, DOMAIN);
	const now = Math.floor(Date.now() / 1000);
	runSql(`INSERT OR REPLACE INTO mta_sts_config (domain_id, workspace_id, enabled, mode, mx_hosts, policy_id, via, state, policy_host, mode_changed_at, policy_published_at, fetch_ok, fetch_checked_at)
		VALUES (${id}, 'ws_default', 1, 'testing', 'mx.${DOMAIN}', '20261101000000', 'cloudflare', 'active', 'worker_route', ${now - 10 * DAY}, ${now - 10 * DAY}, 1, ${now});`);

	const day = new Date(Date.now() - DAY * 1000).toISOString().slice(0, 10);
	const report = JSON.stringify({
		'organization-name': 'Google Inc.', 'contact-info': 'smtp-tls-reporting@google.com', 'report-id': `e2e-${now}`,
		'date-range': { 'start-datetime': `${day}T00:00:00Z`, 'end-datetime': `${day}T23:59:59Z` },
		policies: [{ policy: { 'policy-type': 'sts', 'policy-domain': DOMAIN }, summary: { 'total-successful-session-count': 900, 'total-failure-session-count': 0 } }],
	});
	const mail = [`From: noreply-smtp-tls-reporting@google.com`, `To: tls-rpt@reports.e2e.test`, `Message-ID: <e2e-${now}@google.com>`, `Subject: Report Domain: ${DOMAIN} Submitter: google.com`, 'TLS-Report-Submitter: google.com', 'Content-Type: application/tlsrpt+json', '', report].join('\r\n');
	const sent = await page.request.post(`${baseURL}/cdn-cgi/handler/email?from=${encodeURIComponent('noreply-smtp-tls-reporting@google.com')}&to=${encodeURIComponent('tls-rpt@reports.e2e.test')}`, { data: mail, headers: { 'Content-Type': 'message/rfc822' } });
	expect(sent.status(), await sent.text()).toBeLessThan(300);

	const status = await (await page.request.get(`/api/domains/${id}/mta-sts`)).json();
	expect(status.reports).toHaveLength(1);
	expect(status.reports[0]).toMatchObject({ counted: false, sts_successful_sessions: 900 });
	expect(status.evidence).toMatchObject({ counted_reports: 0, uncounted_reports: 1 });
	expect(status.enforce.allowed).toBe(false);
	const refused = await page.request.patch(`/api/domains/${id}/mta-sts`, { data: { mode: 'enforce' }, headers: { Origin: baseURL! } });
	expect(refused.status()).toBe(422);

	await page.goto(`/#/domains/${id}/mta-sts`);
	await expect(page.getByRole('button', { name: 'Switch to enforce' })).toBeDisabled();
	await expect(page.getByText('1 report is from other senders and not counted.')).toBeVisible();
});
