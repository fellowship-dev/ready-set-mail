// Dead ends and untrue sentences: each screen says what is true for the state shown, per mode and per role.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { Toaster } from '@ready-set-mail/ui';
import { App } from '../src/app';
import { createQueryClient } from '../src/lib/query';
import { OrdersPage, ordersUnavailable } from '../src/pages/operator/OrdersPage';
import { ReportBrowserPage } from '../src/pages/reports/ReportBrowserPage';
import { MembersPage } from '../src/pages/members/MembersPage';
import { SettingsPage, passwordChangedNote } from '../src/pages/settings/SettingsPage';
import { fail, me, mockApi, renderApp, STATUS } from './render';

const at = (route: string) => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

describe('read-only members are not offered what refuses them', () => {
	const boot = (role: 'owner' | 'admin' | 'member') => {
		mockApi({ 'GET /api/auth/status': STATUS, 'GET /api/me': me(role), 'GET /api/domains': { domains: [] }, 'GET /api/workspaces': { workspaces: [] } });
		render(<App queryClient={createQueryClient()} Router={at('/')} />);
		return screen.findByRole('navigation', { name: 'Main' });
	};

	it('a member has no Members and no Audit log in the navigation; the rest stays', async () => {
		const nav = await boot('member');
		await within(nav).findByRole('link', { name: 'Domains' });
		expect(within(nav).queryByRole('link', { name: 'Members' })).toBeNull();
		expect(within(nav).queryByRole('link', { name: 'Audit log' })).toBeNull();
		expect(within(nav).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
	});

	it.each(['owner', 'admin'] as const)('%s keeps both', async (role) => {
		const nav = await boot(role);
		expect(await within(nav).findByRole('link', { name: 'Members' })).toBeInTheDocument();
		expect(within(nav).getByRole('link', { name: 'Audit log' })).toBeInTheDocument();
	});
});

describe('Settings: password', () => {
	const routes = {
		'GET /api/workspaces': { workspaces: [{ id: 'ws_default', name: 'Fellowship', role: 'owner', member_count: 1, created_at: 1 }] },
		'GET /api/version': { current: '1.2.0', latest: '1.2.0', update_available: false, release_url: '' },
		'GET /api/mcp/connections': { connections: [] }, 'GET /api/access': { products: [], principals: [], credentials: [], grants: [] }, 'GET /api/resources': { domains: [] },
		'GET /api/metrics/google/connections': { configured: false, connections: [] },
		'GET /api/cloudflare/connections': { connections: [], oauth: { available: false, scopes: [], via_relay: false }, token_paste: true, encryption_configured: true },
		'GET /api/domains': { domains: [] },
	};
	const change = async (extra: Record<string, unknown>, status = {}) => {
		const r = renderApp(<SettingsPage />, { status, routes: { ...routes, ...extra } });
		const user = userEvent.setup();
		await user.type(await screen.findByLabelText('Current password'), 'old-password');
		await user.type(screen.getByLabelText('New password'), 'new-password-1');
		await user.type(screen.getByLabelText('Confirm new password'), 'new-password-1');
		await user.click(screen.getByRole('button', { name: 'Change password' }));
		return r;
	};

	it('a wrong current password says so, in the server\'s words, not "Unexpected error (400)"', async () => {
		await change({ 'POST /api/auth/change-password': fail(400, 'Your current password is not right. Check it and try again.') });
		expect(await screen.findByText('Your current password is not right. Check it and try again.')).toBeInTheDocument();
		expect(screen.queryByText(/Unexpected error/)).toBeNull();
	});

	it('an answer from the sign-in library ({ message }) is shown as it is, never as "Unexpected error"', async () => {
		await change({ 'POST /api/auth/change-password': { __status: 400, body: { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' } } });
		expect(await screen.findByText('Password too short')).toBeInTheDocument();
		expect(screen.queryByText(/Unexpected error/)).toBeNull();
	});

	it('the confirmation names what exists in the mode: agents hosted, API keys self-hosted', () => {
		expect(passwordChangedNote(true)).toMatch(/Agents you connected still work/);
		expect(passwordChangedNote(true)).not.toMatch(/API key/i);
		expect(passwordChangedNote(false)).toMatch(/Your API keys still work/);
		expect(passwordChangedNote(false)).not.toMatch(/Agents you connected/);
	});
});

describe('Members', () => {
	const team = (current: string) => ({
		users: [
			{ id: 'o1', email: 'owner@example.com', name: 'Olive', role: 'owner', last_login_at: 1_700_000_000, created_at: 1_690_000_000 },
			{ id: 'a1', email: 'admin@example.com', name: 'Adam', role: 'admin', last_login_at: null, created_at: 1_690_000_001 },
			{ id: 'm1', email: 'member@example.com', name: 'Mo', role: 'member', last_login_at: null, created_at: 1_690_000_002 },
		],
		current_user_id: current,
	});

	it('the name column keeps a readable width: it wraps below the badge and buttons instead of shrinking to a sliver (375 px)', async () => {
		renderApp(<MembersPage />, { role: 'owner', routes: { 'GET /api/team': team('o1'), 'GET /api/team/invites': { invites: [{ id: 'i1', email: 'p@example.com', role: 'member', invited_by: 'owner@example.com', created_at: 1, expires_at: 2_000_000_000 }] } } });
		const name = (await screen.findByText('Adam')).parentElement!;
		expect(name.className).toMatch(/basis-56/);
		expect((await screen.findByText('p@example.com')).parentElement!.className).toMatch(/basis-56/);
	});

	it('the invite sentence says what this form does about email, on both modes: nothing is sent', async () => {
		for (const mode of ['self-host', 'saas'] as const) {
			const r = renderApp(<MembersPage />, { role: 'owner', status: { mode }, routes: { 'GET /api/team': team('o1') } });
			expect(await screen.findByText('This invite is not emailed: you get a one-time link to pass on. It expires in 7 days.')).toBeInTheDocument();
			expect(document.body.textContent).not.toMatch(/We do not send email/);
			r.unmount();
		}
	});

	it('inviting an address that already has an open invite says the earlier link stopped working', async () => {
		renderApp(<MembersPage />, { role: 'owner', routes: { 'GET /api/team': team('o1'), 'POST /api/team/invite': { token: 'tok-2', replaced: 1 } } });
		const user = userEvent.setup();
		await screen.findByText('Adam');
		await user.type(screen.getByLabelText('Email'), 'new@example.com');
		await user.click(screen.getByRole('button', { name: 'Create invite link' }));
		expect(await screen.findByText('new@example.com already had an open invite: its earlier link no longer works.')).toBeInTheDocument();
	});

	it('a first invite says nothing about an earlier link', async () => {
		renderApp(<MembersPage />, { role: 'owner', routes: { 'GET /api/team': team('o1'), 'POST /api/team/invite': { token: 'tok-1', replaced: 0 } } });
		const user = userEvent.setup();
		await screen.findByText('Adam');
		await user.type(screen.getByLabelText('Email'), 'new@example.com');
		await user.click(screen.getByRole('button', { name: 'Create invite link' }));
		await screen.findByTestId('invite-link');
		expect(document.body.textContent).not.toMatch(/earlier link/);
	});

	describe('changing a role', () => {
		it('the owner gets a role menu on every row but their own and the owner row; an admin gets only badges', async () => {
			renderApp(<MembersPage />, { role: 'owner', routes: { 'GET /api/team': team('o1') } });
			await screen.findByText('Adam');
			expect(screen.getByRole('combobox', { name: 'Role of admin@example.com' })).toBeInTheDocument();
			expect(screen.getByRole('combobox', { name: 'Role of member@example.com' })).toBeInTheDocument();
			expect(screen.queryByRole('combobox', { name: 'Role of owner@example.com' })).toBeNull();
		});

		it('an admin cannot change roles', async () => {
			renderApp(<MembersPage />, { role: 'admin', routes: { 'GET /api/team': team('a1') } });
			await screen.findByText('Mo');
			expect(screen.queryByRole('combobox', { name: /^Role of / })).toBeNull();
		});

		it('choosing Admin for a member posts the role to the workspace and says what changed', async () => {
			let users = team('o1').users;
			const { calls } = renderApp(<><MembersPage /><Toaster /></>, {
				role: 'owner',
				routes: {
					'GET /api/team': () => ({ users, current_user_id: 'o1' }),
					'POST /api/workspaces/ws_default/members/m1/role': ({ body }: { body: { role: string } }) => { users = users.map((u) => (u.id === 'm1' ? { ...u, role: body.role } : u)); return { ok: true, role: body.role, changed: true }; },
				},
			});
			const user = userEvent.setup();
			await user.click(await screen.findByRole('combobox', { name: 'Role of member@example.com' }));
			await user.click(await screen.findByRole('option', { name: 'Admin' }));
			await waitFor(() => expect(calls.find((c) => c.path === '/api/workspaces/ws_default/members/m1/role')?.body).toEqual({ role: 'admin' }));
			expect(await screen.findByText('member@example.com is now an admin')).toBeInTheDocument();
			await waitFor(() => expect(screen.getByRole('combobox', { name: 'Role of member@example.com' })).toHaveTextContent('Admin'));
		});

		it('a refusal from the server is shown, not swallowed', async () => {
			renderApp(<><MembersPage /><Toaster /></>, { role: 'owner', routes: { 'GET /api/team': team('o1'), 'POST /api/workspaces/ws_default/members/a1/role': fail(403, 'only an owner can change a role') } });
			const user = userEvent.setup();
			await user.click(await screen.findByRole('combobox', { name: 'Role of admin@example.com' }));
			await user.click(await screen.findByRole('option', { name: 'Member (read-only)' }));
			expect(await screen.findByText('only an owner can change a role')).toBeInTheDocument();
		});
	});

	describe('removing someone', () => {
		it('says they lose this workspace and keep their account, whatever else they belong to', async () => {
			renderApp(<MembersPage />, { role: 'owner', routes: { 'GET /api/team': team('o1') } });
			await userEvent.setup().click(await screen.findByRole('button', { name: 'Remove member@example.com' }));
			const dialog = within(await screen.findByRole('dialog'));
			expect(dialog.getByText(/They lose access to this workspace immediately/)).toBeInTheDocument();
			expect(dialog.getByText(/They keep their account\./)).toBeInTheDocument();
			expect(document.body.textContent).not.toMatch(/deletes their login|sign up again/);
		});

		it('names what ends per mode: agents hosted (no key screen), API keys self-hosted', async () => {
			for (const [mode, say, not] of [['saas', /any agents they connected to it stop working/, /API key/], ['self-host', /their API keys for it stop working/, /agents/]] as const) {
				const r = renderApp(<MembersPage />, { role: 'owner', status: { mode }, routes: { 'GET /api/team': team('o1') } });
				await userEvent.setup().click(await screen.findByRole('button', { name: 'Remove member@example.com' }));
				const dialog = within(await screen.findByRole('dialog'));
				expect(dialog.getByText(say)).toBeInTheDocument();
				expect(dialog.queryByText(not)).toBeNull();
				r.unmount();
			}
		});
	});
});

describe('Settings: delete my account names what exists in the mode', () => {
	it.each([['saas', /agent connections/, /API keys/], ['self-host', /API keys/, /agent connections/]] as const)('%s', async (mode, say, not) => {
		const { DangerZone } = await import('../src/pages/settings/DangerZone');
		renderApp(<DangerZone />, { status: { mode }, routes: { 'GET /api/workspaces': { workspaces: [] } } });
		expect(await screen.findByText(say)).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(not);
	});
});

describe('Settings: your only workspace', () => {
	it('says where leaving leads: start your own (hosted, or the instance owner) or wait for an invitation (self-host member); an owner hands ownership on first', async () => {
		const { onlyWorkspaceNote, leaveNote } = await import('../src/pages/settings/WorkspaceSection');
		expect(onlyWorkspaceNote(true, false)).toBe('This is your only workspace. If you leave it: you keep your account and land on a page where you can start a workspace of your own.');
		expect(onlyWorkspaceNote(false, false)).toBe('This is your only workspace. If you leave it: you keep your account and land on a page where you wait for an invitation, because only the owner of this instance can create workspaces.');
		expect(onlyWorkspaceNote(true, true)).toBe('This is your only workspace, so it cannot be deleted. To leave it, make another member an owner first. You keep your account and land on a page where you can start a workspace of your own.');
		expect(leaveNote(false, true)).toBe('You lose access to its domains and reports. An owner can invite you back.');
		expect(leaveNote(true, false)).toMatch(/An owner can invite you back\. You keep your account and land on a page where you wait for an invitation/);
		const { canCreateWorkspace } = await import('../src/lib/workspaces');
		const only = [{ id: 'ws_x', role: 'owner' as const }];
		expect(canCreateWorkspace('saas', only)).toBe(true);
		expect(canCreateWorkspace('self-host', only)).toBe(false);
		expect(canCreateWorkspace('self-host', [{ id: 'ws_default', role: 'owner' as const }])).toBe(true);
	});
});

describe('Orders when the server will not list them', () => {
	it('the instance owner, billing off: says billing is off and what turns it on', async () => {
		renderApp(<OrdersPage />, { status: { mode: 'saas' }, routes: { 'GET /api/operator/orders': fail(404, 'not found'), 'GET /api/me': { ...me('owner'), instance_owner: true } } });
		expect(await screen.findByText('Billing is off, so there are no orders')).toBeInTheDocument();
		expect(screen.getByText(/set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET on this instance/)).toBeInTheDocument();
		expect(screen.queryByText(/Only the instance owner/)).toBeNull();
	});

	it.each([[404], [403]])('anyone else (%i): the page is not theirs, and no instance setting is named', async (status) => {
		renderApp(<OrdersPage />, { role: 'admin', status: { mode: 'saas' }, routes: { 'GET /api/operator/orders': fail(status, 'x') } });
		expect(await screen.findByText('This page is not available to your account')).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/OWNER_EMAIL|STRIPE|instance owner|whatever their status/i);
	});

	it('self-host: the instance owner is told there are no orders to list, not to set a Stripe key that does nothing here', async () => {
		renderApp(<OrdersPage />, { status: { mode: 'self-host' }, routes: { 'GET /api/operator/orders': fail(404, 'not found'), 'GET /api/me': { ...me('owner'), instance_owner: true } } });
		expect(await screen.findByText('A self-hosted install has no orders')).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/STRIPE|OWNER_EMAIL/);
	});

	it('the words come from one function', () => {
		expect(ordersUnavailable(404, { instanceOwner: false, hosted: true }).body).not.toMatch(/OWNER_EMAIL|STRIPE/);
		expect(ordersUnavailable(403, { instanceOwner: true, hosted: true }).title).toBe('This page is not available to your account');
	});
});

describe('the report browser at a narrow width', () => {
	it('says there are more columns to scroll to (the product\'s scroll cue), instead of cutting Pass, Fail and Total off silently', async () => {
		const report = { id: 1, domain: 'example.com', org_name: 'google.com', report_id: 'r1', date_begin: 1_760_000_000, date_end: 1_760_086_400, total_count: 20, pass_count: 19, fail_count: 1 };
		renderApp(
			<Routes>
				<Route path="/domains/:id/reports" element={<ReportBrowserPage />} />
			</Routes>,
			{ route: '/domains/1/reports', routes: { 'GET /api/domains': { domains: [{ id: 1, domain: 'example.com' }] }, 'GET /api/domains/1/check-summary': { domain_id: 1, total_messages: 0 }, 'GET /api/reports': { reports: [report] } } },
		);
		expect(await screen.findByText('google.com')).toBeInTheDocument();
		expect(screen.getByText('Scroll sideways to see every column.')).toBeInTheDocument();
		for (const col of ['Pass', 'Fail', 'Total']) expect(screen.getByRole('columnheader', { name: col })).toBeInTheDocument();
	});
});
