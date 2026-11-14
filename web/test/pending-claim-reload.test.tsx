import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { domainErrorMessage } from '../src/lib/domain-errors';
import { AddDomainPage } from '../src/pages/domains/AddDomainPage';
import { DomainStep } from '../src/pages/wizards/setup/DomainStep';
import { SetupWizardPage } from '../src/pages/wizards/SetupWizardPage';
import { fail, renderApp } from './render';

const claim = { id: 5, domain: 'acme.io', status: 'pending', txt_name: '_readysetmail.acme.io', txt_value: 'readysetmail-verify=abc', created_at: 1, last_checked_at: null, last_error: null };
const offer = (over: Record<string, unknown> = {}) => ({ connections: [], oauth: { available: false, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true, ...over });
const Page = () => (
	<Routes>
		<Route path="/setup" element={<SetupWizardPage />} />
	</Routes>
);

beforeEach(() => sessionStorage.clear());

/** A reload: nothing is cached, the first (and only) answer of GET /api/domains already carries the claim. */
describe('reopening setup with a pending hosted domain', () => {
	for (const [name, conns] of [
		['Cloudflare can be connected', offer()],
		['Cloudflare cannot be connected', offer({ token_paste: false, encryption_configured: false })],
		['the connections request fails', fail(400)],
	] as const) {
		it(`shows the claim, not an empty field (${name})`, async () => {
			renderApp(<Page />, {
				route: '/setup',
				status: { mode: 'saas', has_domain: false },
				routes: { 'GET /api/domains': { domains: [], pending_claims: [claim] }, 'GET /api/cloudflare/connections': conns, 'GET /api/domains/claims/5/preview': fail(502) },
			});
			expect(await screen.findByRole('heading', { name: 'Verify you own this domain' })).toBeInTheDocument();
			expect(screen.getByText('readysetmail-verify=abc')).toBeInTheDocument();
			expect(screen.queryByRole('heading', { name: 'Which domain do you send email from?' })).not.toBeInTheDocument();
		});
	}
});

describe('the zone list is only asked for with a usable Cloudflare connection', () => {
	const noConn = offer({ token_paste: false, encryption_configured: false });
	it('DomainStep: no connection, no GET /api/zones', async () => {
		const { calls } = renderApp(<DomainStep onDomainSet={() => {}} />, { status: { mode: 'saas' }, routes: { 'GET /api/domains': { domains: [], pending_claims: [] }, 'GET /api/cloudflare/connections': noConn } });
		await screen.findByLabelText('Domain');
		expect(calls.some((c) => c.path === '/api/zones')).toBe(false);
		expect(screen.queryByText(/Connect Cloudflare to write this for you/)).not.toBeInTheDocument();
	});
	it('AddDomainPage: no connection, no GET /api/zones, no Cloudflare in the copy', async () => {
		const { calls } = renderApp(<AddDomainPage />, { status: { mode: 'saas' }, routes: { 'GET /api/cloudflare/connections': noConn } });
		await screen.findByLabelText('Your domain');
		expect(calls.some((c) => c.path === '/api/zones')).toBe(false);
		expect(screen.queryByText(/Cloudflare/)).not.toBeInTheDocument();
		expect(screen.getByText('We walk you through each step and show the exact DNS record to publish.')).toBeInTheDocument();
	});
	it('AddDomainPage: a member never asks for connections or zones', async () => {
		const { calls } = renderApp(<AddDomainPage />, { role: 'member', routes: {} });
		await screen.findByLabelText('Your domain');
		expect(calls.some((c) => c.path === '/api/zones' || c.path.startsWith('/api/cloudflare'))).toBe(false);
	});
	it('AddDomainPage: where Cloudflare can be connected it is mentioned, and still no zone request', async () => {
		const { calls } = renderApp(<AddDomainPage />, { routes: { 'GET /api/cloudflare/connections': offer() } });
		expect(await screen.findByText(/apply DNS changes automatically if your domain is on Cloudflare/)).toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/zones')).toBe(false);
	});
	it('a server token (implicit connection) lists its zones', async () => {
		const { calls } = renderApp(<AddDomainPage />, {
			routes: {
				'GET /api/cloudflare/connections': offer({ connections: [{ id: 'env', label: 'Server', auth_type: 'token', status: 'active', zones: [], scopes: [], implicit: true }] }),
				'GET /api/zones': { zones: [{ id: 'z1', name: 'acme.io' }] },
			},
		});
		expect(await screen.findByRole('combobox')).toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/zones')).toBe(true);
	});
});

describe('domain refusals in plain words', () => {
	it('maps the bare API sentences, keeps everything else', () => {
		expect(domainErrorMessage(new ApiError(400, 'invalid domain format'))).toBe('Enter a domain like yourdomain.com, without https:// or a path.');
		expect(domainErrorMessage(new ApiError(409, 'this domain is already registered in another workspace'))).toBe('This domain is already in another workspace. Use a different domain, or ask for access if it is yours.');
		expect(domainErrorMessage(new ApiError(409, 'domain already registered in another workspace'))).toMatch(/^This domain is already in another workspace/);
		expect(domainErrorMessage(new ApiError(500, 'boom'))).toBe('boom');
	});
	it('a taken domain on hosted keeps the Talk to Max line', async () => {
		renderApp(<DomainStep onDomainSet={() => {}} />, {
			status: { mode: 'saas', help_url: 'https://cal.example.com/max/30min' },
			routes: { 'GET /api/domains': { domains: [], pending_claims: [] }, 'GET /api/cloudflare/connections': fail(403), 'POST /api/settings/base-domain': fail(409, 'this domain is already registered in another workspace') },
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Domain'), 'acme.io');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText(/^This domain is already in another workspace\./)).toBeInTheDocument();
		expect(screen.getByText(/Is this domain yours\?/)).toBeInTheDocument();
	});
});

describe('a claim made in this visit is not hidden by an older cached list', () => {
	it('refetches the domain list when the claim is created', async () => {
		let n = 0;
		const { calls } = renderApp(<DomainStep onDomainSet={() => {}} />, {
			status: { mode: 'saas' },
			routes: {
				'GET /api/domains': () => (++n, { domains: [], pending_claims: n > 1 ? [claim] : [] }),
				'GET /api/cloudflare/connections': fail(403),
				'POST /api/settings/base-domain': { __status: 202, body: { pending: true, claim, domain: 'acme.io' } },
				'GET /api/domains/claims/5/preview': fail(502),
			},
		});
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Domain'), 'acme.io');
		await user.click(screen.getByRole('button', { name: 'Continue' }));
		await screen.findByText('readysetmail-verify=abc');
		await waitFor(() => expect(calls.filter((c) => c.path === '/api/domains' && c.method === 'GET').length).toBeGreaterThan(1));
	});
});
