import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { Toaster } from '@ready-set-mail/ui';
import { beforeEach, describe, expect, it } from 'vitest';
import { accountLabel, connectCloudflarePath, importAll, importSummary } from '../src/lib/cloudflare';
import { CloudflareAttention } from '../src/components/domain/CloudflareAttention';
import { CloudflareSuggestions } from '../src/components/domain/CloudflareSuggestions';
import { DomainRow } from '../src/components/domain/DomainRow';
import { AddDomainPage } from '../src/pages/domains/AddDomainPage';
import { CloudflareSection } from '../src/pages/settings/CloudflareSection';
import { CloudflareWizardPage } from '../src/pages/wizards/cloudflare/CloudflareWizardPage';
import { renderApp } from './render';

const conn = (over: Record<string, unknown> = {}) => ({ id: 'c1', label: 'Example Co', auth_type: 'oauth', status: 'active', status_detail: null, cf_account_id: 'a1', cf_account_name: 'Example Co', zones: [{ id: 'z1', name: 'one.com' }], scopes: [], accounts: [{ id: 'a1', name: 'Example Co' }], ...over });
const offer = (connections: unknown[] = [], over: Record<string, unknown> = {}) => ({ connections, oauth: { available: true, scopes: [], via_relay: false }, token_paste: false, encryption_configured: true, ...over });
const done = (over: Record<string, unknown> = {}) => ({ imported: [], already: 0, skipped: [], removed: 0, more: 0, accounts: [], verified_claims: [], ...over });
const KEY = 'rsm_cf_wizard:ws_default';

function Where() {
	const loc = useLocation();
	return (
		<>
			<p data-testid="where">{loc.pathname}</p>
			<p data-testid="note">{(loc.state as { imported?: { text: string } } | null)?.imported?.text ?? ''}</p>
		</>
	);
}
const Wizard = () => (
	<>
		<Routes>
			<Route path="/setup/cloudflare" element={<CloudflareWizardPage />} />
			<Route path="*" element={<Where />} />
		</Routes>
		<Toaster />
	</>
);
const hosted = { mode: 'saas', has_domain: false } as const;

beforeEach(() => {
	sessionStorage.clear();
	window.history.replaceState(null, '', '/');
});

describe('hosted wizard: connected, then every zone is added', () => {
	it('adds all zones in one request, says what happened, and lands on the dashboard', async () => {
		const { calls } = renderApp(<Wizard />, {
			route: '/setup/cloudflare',
			status: hosted,
			routes: {
				'GET /api/cloudflare/connections': offer([conn()]),
				'POST /api/cloudflare/connections/c1/import': done({ imported: [{ domain: 'one.com', domain_id: 1 }, { domain: 'two.org', domain_id: 2 }], accounts: [{ id: 'a1', name: 'Example Co' }] }),
			},
		});
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
		const imp = calls.filter((c) => c.path.endsWith('/import'));
		expect(imp).toHaveLength(1);
		expect(imp[0]!.body).toEqual({}); // no zone ids: everything, as the server decides
		// said on the dashboard, in the page, never as a toast over it
		expect(screen.getByTestId('note')).toHaveTextContent('Added 2 domains from Example Co. Nothing in your DNS was changed.');
		expect(within(screen.getByRole('region', { name: /Notifications/ })).queryByText(/Added 2 domains/)).toBeNull(); // no toast
		expect(calls.some((c) => c.path.includes('/zones'))).toBe(false); // no zone list to tick, no DNS plan
		expect(calls.some((c) => c.path.includes('/onboarding/dns-plan'))).toBe(false);
		expect(sessionStorage.getItem(KEY)).toBeNull();
	});

	it('asks again while the server says more remain', async () => {
		let n = 0;
		const { calls } = renderApp(<Wizard />, {
			route: '/setup/cloudflare',
			status: hosted,
			routes: {
				'GET /api/cloudflare/connections': offer([conn()]),
				'POST /api/cloudflare/connections/c1/import': () => (++n === 1 ? done({ imported: [{ domain: 'a.com', domain_id: 1 }], more: 1, accounts: [{ id: 'a1', name: 'Example Co' }] }) : done({ imported: [{ domain: 'b.com', domain_id: 2 }] })),
			},
		});
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
		expect(calls.filter((c) => c.path.endsWith('/import'))).toHaveLength(2);
		expect(screen.getByTestId('note')).toHaveTextContent('Added 2 domains from Example Co. Nothing in your DNS was changed.');
	});

	it('when the plan covers fewer domains than there are zones, shows the list with the plan\'s number and imports the chosen ones', async () => {
		const zones = ['a.com', 'b.com', 'c.com', 'd.com'].map((name, i) => ({ id: `z${i}`, name, account_id: 'a1', account_name: 'Example Co' }));
		let first = true;
		const { calls } = renderApp(<Wizard />, {
			route: '/setup/cloudflare',
			status: hosted,
			routes: {
				'GET /api/cloudflare/connections': offer([conn()]),
				'POST /api/cloudflare/connections/c1/import': ({ body }: { body: any }) => (first ? ((first = false), done({ needs_selection: { room: 2, cap: 2, zones } })) : done({ imported: body.zone_ids.map((id: string, i: number) => ({ domain: zones.find((z) => z.id === id)!.name, domain_id: i + 1 })), accounts: [{ id: 'a1', name: 'Example Co' }] })),
			},
		});
		expect(await screen.findByText('Your plan covers 2 domains. Choose which to add.')).toBeInTheDocument();
		const add = screen.getByRole('button', { name: 'Add domains' });
		expect(add).toBeDisabled();
		const boxes = screen.getAllByRole('checkbox');
		expect(boxes.every((b) => !(b as HTMLInputElement).checked && b.getAttribute('data-state') !== 'checked')).toBe(true); // nothing is chosen for them
		for (const i of [0, 1, 2]) await userEvent.click(boxes[i]!);
		expect(screen.getByText('3 of 2 chosen')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Add 3 domains' })).toBeDisabled();
		await userEvent.click(boxes[2]!);
		await userEvent.click(screen.getByRole('button', { name: 'Add 2 domains' }));
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
		expect(calls.filter((c) => c.path.endsWith('/import')).at(-1)!.body).toEqual({ zone_ids: ['z0', 'z1'] });
	});

	it('a plan that is already full says so and does not ask to choose', async () => {
		renderApp(<Wizard />, { route: '/setup/cloudflare', status: hosted, routes: { 'GET /api/cloudflare/connections': offer([conn()]), 'POST /api/cloudflare/connections/c1/import': done({ needs_selection: { room: 0, cap: 2, zones: [{ id: 'z1', name: 'a.com', account_id: null, account_name: null }] } }) } });
		expect(await screen.findByText(/Your plan covers 2 domains and this workspace has them all/)).toBeInTheDocument();
		expect(screen.queryByRole('checkbox')).toBeNull();
		await userEvent.click(screen.getByRole('button', { name: 'Go to dashboard' }));
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
	});

	it('an account with no active zones says so and leaves by a button', async () => {
		renderApp(<Wizard />, { route: '/setup/cloudflare', status: hosted, routes: { 'GET /api/cloudflare/connections': offer([conn()]), 'POST /api/cloudflare/connections/c1/import': done() } });
		expect(await screen.findByText(/has no active zones/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Go to dashboard' }));
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
	});

	it('a failed import can be tried again', async () => {
		let n = 0;
		renderApp(<Wizard />, { route: '/setup/cloudflare', status: hosted, routes: { 'GET /api/cloudflare/connections': offer([conn()]), 'POST /api/cloudflare/connections/c1/import': () => (++n === 1 ? { __status: 502, body: { error: 'Cloudflare did not answer' } } : done({ imported: [{ domain: 'a.com', domain_id: 1 }] })) } });
		await userEvent.click(await screen.findByRole('button', { name: /try again/i }));
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
	});

	it('self-host keeps the zone list, the domain step and the DNS plan', async () => {
		renderApp(<Wizard />, {
			route: '/setup/cloudflare',
			routes: { 'GET /api/cloudflare/connections': offer([conn({ auth_type: 'token', zones: [] })]), 'GET /api/cloudflare/connections/c1/zones': { zones: [{ id: 'z1', name: 'one.com', allowed: false }] } },
		});
		expect(await screen.findByRole('heading', { name: 'Choose zones' })).toBeInTheDocument();
	});
});

describe('the status line and the entry points', () => {
	it('importSummary is plain: counts, accounts, and that DNS was not touched', () => {
		const t = { imported: ['a.com'], skipped: [], already: 0, accounts: ['Example Co'], verifiedClaims: [] };
		expect(importSummary(t)).toBe('Added 1 domain from Example Co. Nothing in your DNS was changed.');
		expect(importSummary({ ...t, imported: ['a.com', 'b.com'], accounts: ['One', 'Two'] })).toBe('Added 2 domains from One and Two. Nothing in your DNS was changed.');
		expect(importSummary({ ...t, imported: [], already: 3 })).toBe('Your Cloudflare domains were already added. Nothing in your DNS was changed.');
		// each zone's own reason, as the server gave it: never one guess for all of them
		expect(importSummary({ ...t, skipped: [{ domain: 'x.com', reason: 'A parent or a subdomain of this name is already verified in another workspace.' }] })).toBe('Added 1 domain from Example Co. Nothing in your DNS was changed. 1 zone was not added: x.com. A parent or a subdomain of this name is already verified in another workspace.');
		expect(importSummary({ ...t, skipped: [{ domain: 'x.com', reason: 'r1' }, { domain: 'y.com', reason: 'r2' }] })).toBe('Added 1 domain from Example Co. Nothing in your DNS was changed. 2 zones were not added. x.com: r1 y.com: r2');
	});

	it('connect goes into the wizard from the dashboard and setup, and to the connect page (with a way back) elsewhere', () => {
		expect(connectCloudflarePath('/')).toBe('/setup/cloudflare');
		expect(connectCloudflarePath('/setup')).toBe('/setup/cloudflare');
		expect(connectCloudflarePath('/domains/5/setup/2', '?x=1')).toBe('/cloudflare/connect?back=%2Fdomains%2F5%2Fsetup%2F2%3Fx%3D1');
		expect(connectCloudflarePath('/settings')).toBe('/cloudflare/connect?back=%2Fsettings');
	});

	it('importAll stops at a selection and returns what was done before it', async () => {
		renderApp(<p />, { routes: { 'POST /api/cloudflare/connections/c1/import': done({ needs_selection: { room: 1, cap: 1, zones: [] } }) } });
		expect((await importAll('c1')).selection).toMatchObject({ room: 1, cap: 1 });
	});
});

describe('several Cloudflare accounts', () => {
	const accounts = [
		{ id: 'a1', name: 'Example Co', domains: 3, state: 'working', connected_by: 'owner@example.com', connected_at: 1700000000, connections: [{ id: 'c1', label: 'Example Co', status: 'active' }, { id: 'c2', label: 'Again', status: 'active' }] },
		{ id: 'a2', name: 'Side Project', domains: 1, state: 'needs_reconnect', connected_by: null, connected_at: 1700000000, connections: [{ id: 'c3', label: 'Side', status: 'broken' }] },
	];

	it('Settings lists each account once with its domains, state, who connected it, and "2 connections"', async () => {
		renderApp(<CloudflareSection />, { routes: { 'GET /api/cloudflare/connections': { ...offer([conn(), conn({ id: 'c2', label: 'Again' }), conn({ id: 'c3', label: 'Side', status: 'broken', accounts: [{ id: 'a2', name: 'Side Project' }] })]), accounts } } });
		const list = await screen.findByRole('list', { name: 'Cloudflare accounts' });
		const items = within(list).getAllByRole('listitem');
		expect(items).toHaveLength(2);
		expect(within(items[0]!).getByText('Example Co')).toBeInTheDocument();
		expect(within(items[0]!).getByText(/3 domains · 2 connections/)).toBeInTheDocument();
		expect(within(items[0]!).getByText(/Connected by owner@example.com on/)).toBeInTheDocument();
		expect(within(items[0]!).getByText('Working')).toBeInTheDocument();
		expect(within(items[1]!).getByText('Needs reconnecting')).toBeInTheDocument();
		expect(within(items[1]!).getByText(/1 domain$/)).toBeInTheDocument();
	});

	it('disconnecting a sign-in that covers two accounts names the other one, and says the domains stay', async () => {
		renderApp(<CloudflareSection />, {
			routes: { 'GET /api/cloudflare/connections': { ...offer([conn({ accounts: [{ id: 'a1', name: 'Example Co' }, { id: 'a2', name: 'Side Project' }] })]), accounts: [accounts[0]] } },
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
		expect(await screen.findByText('This also disconnects Side Project, which was connected in the same sign-in.')).toBeInTheDocument();
		expect(screen.getByText(/Your domains stay in Ready Set Mail, verified and watched\. Changing their DNS needs a reconnect\./)).toBeInTheDocument();
		expect(screen.queryByText(/This also disconnects Example Co/)).toBeNull();
	});

	it('a one-account sign-in has no "also disconnects" line', async () => {
		renderApp(<CloudflareSection />, { routes: { 'GET /api/cloudflare/connections': { ...offer([conn()]), accounts: [accounts[0]] } } });
		await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
		await screen.findByText(/Your domains stay in Ready Set Mail/);
		expect(screen.queryByText(/This also disconnects/)).toBeNull();
	});

	it('a domain row names its account only when the workspace has more than one', async () => {
		const verdict = { status: 'attention', level: 0, sentence: 'Public DNS shows no SPF record.', evidence: null, checked: null, next: { label: 'Publish an SPF record', who: 'You', to: '/domains/1/setup/2' }, reportsNotConnected: false, reportsConfirmed: false, help: null } as never;
		const row = (accts: unknown[]) =>
			renderApp(<ul><DomainRow domain={{ id: 1, domain: 'one.com', cf_account_id: 'a2' }} verdict={verdict} canWrite /></ul>, { routes: { 'GET /api/cloudflare/connections': { ...offer([conn()]), accounts: accts } } });
		const two = row(accounts);
		expect(await screen.findByText('Cloudflare account Side Project')).toBeInTheDocument();
		two.unmount();
		row([accounts[1]]);
		await screen.findByText('one.com');
		await waitFor(() => expect(screen.queryByText(/Cloudflare account/)).toBeNull());
		expect(accountLabel(undefined, 'a1')).toBeNull();
	});
});

describe('suggestions and attention on the dashboard', () => {
	it('Add domain offers zones that are not domains yet, marks removed ones, and adds one by id', async () => {
		let added = false;
		const { calls } = renderApp(<><CloudflareSuggestions /><Toaster /></>, {
			status: hosted,
			routes: {
				'GET /api/cloudflare/connections': { ...offer([conn()]), accounts: [] },
				'GET /api/cloudflare/suggestions': { suggestions: [{ connection_id: 'c1', account_id: 'a1', account_name: 'Example Co', zone_id: 'z9', name: 'new.io', removed: false }, { connection_id: 'c1', account_id: 'a1', account_name: 'Example Co', zone_id: 'z8', name: 'old.io', removed: true }] },
				'POST /api/cloudflare/connections/c1/import': () => ((added = true), done({ imported: [{ domain: 'new.io', domain_id: 7 }], accounts: [{ id: 'a1', name: 'Example Co' }] })),
			},
		});
		expect(await screen.findByText('new.io')).toBeInTheDocument();
		expect(screen.getByText('You removed it earlier')).toBeInTheDocument();
		await userEvent.click(screen.getByRole('button', { name: 'Add new.io' }));
		await waitFor(() => expect(added).toBe(true));
		expect(calls.find((c) => c.path.endsWith('/import'))!.body).toEqual({ zone_ids: ['z9'] });
		// in the page, next to the list it is about: a toast would float over whatever is under it
		const note = await screen.findByText('Added 1 domain from Example Co. Nothing in your DNS was changed.');
		expect(note.closest('section')).not.toBeNull();
		expect(within(screen.getByRole('region', { name: /Notifications/ })).queryByText(/Added 1 domain/)).toBeNull();
	});

	it('shows nothing when there is nothing to suggest', async () => {
		const { container } = renderApp(<CloudflareSuggestions />, { status: hosted, routes: { 'GET /api/cloudflare/connections': offer([conn()]), 'GET /api/cloudflare/suggestions': { suggestions: [] } } });
		await waitFor(() => expect(container.textContent).toBe(''));
	});

	it('a connection that stopped working is said at the top, with the way to fix it; new zones are one quiet line', async () => {
		renderApp(<Routes><Route path="*" element={<CloudflareAttention />} /></Routes>, {
			status: hosted,
			routes: {
				'GET /api/cloudflare/connections': offer([conn({ status: 'broken' }), conn({ id: 'c2', label: 'Fine' })]),
				'GET /api/cloudflare/suggestions': { suggestions: [{ connection_id: 'c2', account_id: 'a1', account_name: 'X', zone_id: 'z9', name: 'new.io', removed: false }, { connection_id: 'c2', account_id: 'a1', account_name: 'X', zone_id: 'z8', name: 'old.io', removed: true }] },
			},
		});
		expect(await screen.findByText('Cloudflare needs to be reconnected')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Reconnect in Settings' })).toHaveAttribute('href', '/settings');
		expect(await screen.findByText(/1 new domain in your Cloudflare account:/)).toBeInTheDocument();
	});

	it('shows nothing to people who cannot connect Cloudflare', async () => {
		const { container } = renderApp(<CloudflareAttention />, { role: 'member', routes: {} });
		await waitFor(() => expect(container.textContent).toBe(''));
	});
});

describe('Add domain: a name inside a connected zone', () => {
	it('says it is verified on the spot; a name outside every zone says nothing', async () => {
		renderApp(<AddDomainPage />, {
			status: hosted,
			routes: {
				'GET /api/cloudflare/connections': offer([conn()]),
				'GET /api/cloudflare/connections/c1/zones': { zones: [{ id: 'z1', name: 'one.com', allowed: true }] },
				'GET /api/cloudflare/suggestions': { suggestions: [] },
			},
		});
		await userEvent.click(await screen.findByRole('button', { name: 'Enter manually' }));
		const field = screen.getByLabelText('Your domain');
		await userEvent.type(field, 'shop.one.com');
		expect(screen.getByText('shop.one.com is in your Cloudflare zone one.com, so it is verified on the spot.')).toBeInTheDocument();
		await userEvent.clear(field);
		await userEvent.type(field, 'other.org');
		expect(screen.queryByText(/verified on the spot/)).toBeNull();
		await userEvent.clear(field);
		await userEvent.type(field, 'notone.com');
		expect(screen.queryByText(/verified on the spot/)).toBeNull(); // a lookalike is not inside the zone
	});
});
