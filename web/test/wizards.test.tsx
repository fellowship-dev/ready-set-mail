import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DmarcWizardPage } from '../src/pages/wizards/DmarcWizardPage';
import { fail, renderApp, type Handler } from './render';

const domain = { id: 3, domain: 'example.com', dmarc_policy: 'none', rua_address: 'r@reports.example.com', parent_id: null, created_at: 1, alerts_enabled: 1, is_default: 1 };

/** Stored evidence the shared rule accepts for the next policy: reports connected here, 99% of 1,000 messages pass. */
const DMARC_READY = { domain_id: 3, domain: 'example.com', dmarc_policy: 'none', spf_record: 'v=spf1 -all', dns_checked_at: Math.floor(Date.now() / 1000), dns_check_attempted_at: null, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok', total_messages: 1000, pass_messages: 990, fail_messages: 10, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 1, dmarc_pct: 100, dmarc_p: 'none', dmarc_sp: null, dmarc_rua: 1 };

const mount = (path: string, element: React.ReactElement) => (
	<Routes>
		<Route path={path} element={element} />
	</Routes>
);

describe('DMARC graduation wizard', () => {
	const ui = mount('/domains/:id/dmarc-wizard', <DmarcWizardPage />);
	const current = 'v=DMARC1; p=none; sp=none; rua=mailto:r@reports.example.com';
	const routesFor = (extra: Record<string, unknown | Handler> = {}, dns: unknown = { found: true, has_rua: true, current_record: current, cf_managed: false }) => ({
		'GET /api/domains': { domains: [domain] },
		'GET /api/domains/3/check-summary': DMARC_READY, 'GET /api/domains/3/dns-check': dns,
		...extra,
	});

	it('manual path advances with NO API call and says Ready Set Mail will detect the change', async () => {
		const { calls } = renderApp(ui, { route: '/domains/3/dmarc-wizard', routes: routesFor() });
		expect(await screen.findByText('Step 1: switch to quarantine')).toBeInTheDocument();
		expect(screen.getByText(/Confirming makes no change on our side/)).toBeInTheDocument();
		expect(screen.getAllByText('v=DMARC1; p=quarantine; sp=none; rua=mailto:r@reports.example.com').length).toBeGreaterThan(0);
		const before = calls.length;
		await userEvent.click(screen.getByRole('button', { name: "I've updated it manually" }));
		expect(await screen.findByText('Step 2: switch to reject')).toBeInTheDocument();
		expect(screen.getByText(/Step 2 of 3/)).toBeInTheDocument();
		expect(calls.slice(before)).toEqual([]);
		await userEvent.click(screen.getByRole('button', { name: 'Back' }));
		expect(await screen.findByText('Step 1: switch to quarantine')).toBeInTheDocument();
	});

	it('Cloudflare-managed: PATCHes the policy, refetches domains and advances', async () => {
		let policy = 'none';
		const { calls } = renderApp(ui, {
			route: '/domains/3/dmarc-wizard',
			routes: {
				'GET /api/domains': () => ({ domains: [{ ...domain, dmarc_policy: policy }] }),
				'GET /api/domains/3/check-summary': DMARC_READY, 'GET /api/domains/3/dns-check': { found: true, has_rua: true, current_record: current, cf_managed: true },
				'PATCH /api/domains/3/dmarc': () => {
					policy = 'quarantine';
					return { ok: true, policy: 'quarantine', record: 'v=DMARC1; p=quarantine; sp=none; rua=mailto:r@reports.example.com' };
				},
			},
		});
		const apply = await screen.findByRole('button', { name: 'Apply via Cloudflare' });
		await waitFor(() => expect(apply).toBeEnabled());
		await userEvent.click(apply);
		expect(await screen.findByText('Step 2: switch to reject')).toBeInTheDocument();
		expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ policy: 'quarantine' });
		expect(screen.getByText('v=DMARC1; p=reject; sp=none; rua=mailto:r@reports.example.com')).toBeInTheDocument();
	});

	it('starts from the live policy and shows the finished state for reject', async () => {
		renderApp(ui, { route: '/domains/3/dmarc-wizard', routes: routesFor({}, { found: true, has_rua: true, current_record: 'v=DMARC1; p=reject; rua=mailto:r@reports.example.com', cf_managed: false }) });
		expect(await screen.findByRole('heading', { name: 'Fully enforced' })).toBeInTheDocument();
		expect(screen.getAllByRole('link', { name: 'Back to domain' }).every((l) => l.getAttribute('href') === '/domains/3')).toBe(true);
	});

	it('quarantine starts at step 2 of 2', async () => {
		renderApp(ui, { route: '/domains/3/dmarc-wizard', routes: routesFor({}, { found: true, has_rua: true, current_record: 'v=DMARC1; p=quarantine; rua=mailto:r@reports.example.com', cf_managed: false }) });
		expect(await screen.findByText('Step 2: switch to reject')).toBeInTheDocument();
		// Already at quarantine: there is no step back to offer.
		expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
	});

	it('never proposes a downgrade when the stored policy lags a live p=reject', async () => {
		const live = 'v=DMARC1; p=reject; rua=mailto:r@reports.example.com';
		renderApp(ui, {
			route: '/domains/3/dmarc-wizard',
			routes: { 'GET /api/domains': { domains: [{ ...domain, dmarc_policy: 'none' }] }, 'GET /api/domains/3/check-summary': DMARC_READY, 'GET /api/domains/3/dns-check': { found: true, has_rua: true, current_record: live, cf_managed: false } },
		});
		expect(await screen.findByRole('heading', { name: 'Fully enforced' })).toBeInTheDocument();
		expect(screen.queryByText(/p=quarantine/)).not.toBeInTheDocument();
		expect(screen.queryByText('Step 1: switch to quarantine')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: "I've updated it manually" })).not.toBeInTheDocument();
	});

	it('a live p=quarantine with a stored p=none starts at reject, not at quarantine', async () => {
		renderApp(ui, {
			route: '/domains/3/dmarc-wizard',
			routes: {
				'GET /api/domains': { domains: [{ ...domain, dmarc_policy: 'none' }] },
				'GET /api/domains/3/check-summary': DMARC_READY, 'GET /api/domains/3/dns-check': { found: true, has_rua: true, current_record: 'v=DMARC1; p=quarantine; rua=mailto:r@reports.example.com', cf_managed: false },
			},
		});
		expect(await screen.findByText('Step 2: switch to reject')).toBeInTheDocument();
		expect(screen.getAllByText('v=DMARC1; p=reject; rua=mailto:r@reports.example.com').length).toBeGreaterThan(0);
	});

	it('a failed DNS lookup offers nothing to apply, instead of building a record from nothing', async () => {
		renderApp(ui, {
			route: '/domains/3/dmarc-wizard',
			routes: routesFor({}, { found: false, has_rua: false, current_record: null, cf_managed: false, error: 'dns lookup failed' }),
		});
		const row = (await screen.findByText('Lookup failed')).closest('li') as HTMLElement;
		expect(row).toHaveAttribute('data-status', 'error');
		expect(within(row).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: "I've updated it manually" })).not.toBeInTheDocument();
		expect(screen.queryByText('New record')).not.toBeInTheDocument();
	});

	it('members see the notice and cannot apply', async () => {
		renderApp(ui, {
			role: 'member',
			route: '/domains/3/dmarc-wizard',
			routes: routesFor({}, { found: true, has_rua: true, current_record: current, cf_managed: true }),
		});
		expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
		expect(await screen.findByRole('button', { name: 'Apply via Cloudflare' })).toBeDisabled();
	});

	it('shows an apply error inline', async () => {
		renderApp(ui, {
			route: '/domains/3/dmarc-wizard',
			routes: routesFor({ 'PATCH /api/domains/3/dmarc': () => fail(502, 'Cloudflare refused') }, { found: true, has_rua: true, current_record: current, cf_managed: true }),
		});
		const apply = await screen.findByRole('button', { name: 'Apply via Cloudflare' });
		await waitFor(() => expect(apply).toBeEnabled());
		await userEvent.click(apply);
		expect(await screen.findByText('Cloudflare refused')).toBeInTheDocument();
	});
});
