import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AgentConnectionsSection } from '../src/pages/settings/AgentConnectionsSection';
import { MetricConnectionsSection } from '../src/pages/settings/MetricConnectionsSection';
import { fail, renderApp } from './render';

const empty = { products: [], principals: [], credentials: [], grants: [] };
const connections = { 'GET /api/mcp/connections': { connections: [] } };
const TITLE = /^Access keys for scripts and services/;

/** The access-key section is collapsed until opened. */
async function openKeys(user: ReturnType<typeof userEvent.setup>) {
	const toggle = await screen.findByRole('button', { name: TITLE });
	expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await user.click(toggle);
	expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

describe('access keys for scripts and services', () => {
	it('is collapsed by default, says it is optional and who it is for', async () => {
		renderApp(<AgentConnectionsSection />, { routes: { ...connections, 'GET /api/access': empty, 'GET /api/resources': { domains: [] } } });
		const toggle = await screen.findByRole('button', { name: TITLE });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		expect(toggle).toHaveAccessibleName(/Optional\. For programs that run without a person, such as a CI job that checks your domains every night\./);
		expect(await screen.findByText(/You do not need one to use Ready Set Mail or to connect an AI agent/)).not.toBeVisible();
	});

	it('creates a group, puts a domain in it, creates a key with exactly the chosen actions, shows it once with how to use it, then hides it', async () => {
		let product = false, mapped = false;
		const { calls } = renderApp(<AgentConnectionsSection />, {
			routes: {
				...connections,
				'GET /api/access': () => ({ ...empty, products: product ? [{ id: 'product1', name: 'Receipts' }] : [] }),
				'GET /api/resources': () => ({ domains: [{ id: 7, domain: 'mail.example.com', mappedProductIds: mapped ? ['product1', 'shared-product'] : [] }] }),
				'POST /api/access/products': () => {
					product = true;
					return { id: 'product1', name: 'Receipts' };
				},
				'PUT /api/access/products/product1/domains/7': () => {
					mapped = true;
					return { ok: true };
				},
				'POST /api/access/principals': { id: 'principal1' },
				'POST /api/access/grants': { id: 'grant1' },
				'POST /api/access/credentials': { id: 'credential1', key: 'ias_initial-secret-only', prefix: 'ias_ini' },
			},
		});
		const user = userEvent.setup();
		await openKeys(user);
		expect(screen.getByText(/No groups yet/)).toBeVisible();
		await user.type(screen.getByLabelText('New group name'), 'Receipts');
		await user.click(screen.getByRole('button', { name: 'Create group' }));
		expect(await screen.findByLabelText('Group')).toHaveValue('product1');
		expect(calls.find((c) => c.path === '/api/access/products')?.body).toEqual({ name: 'Receipts' });

		const inGroup = screen.getByRole('group', { name: 'Domains in Receipts' });
		await user.click(within(inGroup).getByRole('checkbox', { name: /^mail\.example\.com/ }));
		await within(inGroup).findByText('Also in another group');

		// Each action reads in plain words, with its raw id as secondary text.
		const actions = screen.getByRole('group', { name: 'What it may do' });
		expect(within(actions).getByRole('checkbox', { name: 'See its domains' })).toBeChecked();
		expect(within(actions).getByRole('checkbox', { name: 'Read email health reports' })).toBeChecked();
		expect(within(actions).getByText('diagnostics:run')).toBeInTheDocument();
		await user.click(within(actions).getByRole('checkbox', { name: 'Run live DNS checks' }));

		const keyDomains = screen.getByRole('group', { name: 'Domains this key may see' });
		await user.click(within(keyDomains).getByRole('checkbox', { name: 'mail.example.com' }));
		await user.type(screen.getByLabelText('Key name'), 'Receipt worker');
		await user.click(screen.getByRole('button', { name: 'Create key' }));

		const secret = await screen.findByLabelText('New key');
		expect(secret).toHaveAttribute('type', 'password');
		expect(secret).toHaveValue('ias_initial-secret-only');
		expect(screen.getByText('Copy this key now. It is shown only once.')).toBeInTheDocument();
		// How to use it: the header, a request this key may make, and the MCP address. The secret itself is never printed.
		expect(screen.getByLabelText('Try it: list the domains this key can see')).toHaveTextContent(`curl -H "X-Api-Key: $READY_SET_MAIL_KEY" ${window.location.origin}/api/resources`);
		expect(screen.getByLabelText('MCP address, for an agent that runs on its own')).toHaveTextContent(`${window.location.origin}/mcp`);
		expect(document.body.textContent).not.toContain('ias_initial-secret-only');
		expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled();

		const grant = calls.find((c) => c.path === '/api/access/grants');
		expect(grant?.body).toMatchObject({ principal_id: 'principal1', product_id: 'product1', domain: 'mail.example.com', actions: ['resources:read', 'reports:read', 'diagnostics:run'] });
		expect(grant?.body.expires_at).toBeGreaterThan(Date.now() / 1000);
		expect(calls.find((c) => c.path === '/api/access/principals')?.body).toEqual({ name: 'Receipt worker', kind: 'service' });
		expect(JSON.stringify({ ...localStorage })).not.toContain('ias_initial-secret-only');
		expect(JSON.stringify({ ...sessionStorage })).not.toContain('ias_initial-secret-only');

		await user.click(screen.getByRole('button', { name: 'I saved the key, hide it' }));
		await waitFor(() => expect(screen.queryByLabelText('New key')).not.toBeInTheDocument());
	});

	it('without "See its domains", the example reads a health report the key may read', async () => {
		renderApp(<AgentConnectionsSection />, {
			routes: {
				...connections,
				'GET /api/access': { ...empty, products: [{ id: 'p', name: 'Store' }] },
				'GET /api/resources': { domains: [{ id: 7, domain: 'mail.example.com', mappedProductIds: ['p'] }] },
				'POST /api/access/principals': { id: 'pr' },
				'POST /api/access/grants': { id: 'g' },
				'POST /api/access/credentials': { id: 'c', key: 'ias_x', prefix: 'ias_x' },
			},
		});
		const user = userEvent.setup();
		await openKeys(user);
		await user.selectOptions(screen.getByLabelText('Group'), 'p');
		await user.click(within(screen.getByRole('group', { name: 'What it may do' })).getByRole('checkbox', { name: 'See its domains' }));
		await user.click(within(screen.getByRole('group', { name: 'Domains this key may see' })).getByRole('checkbox', { name: 'mail.example.com' }));
		await user.type(screen.getByLabelText('Key name'), 'Reports only');
		await user.click(screen.getByRole('button', { name: 'Create key' }));
		expect(await screen.findByLabelText('Try it: read the health report of mail.example.com')).toHaveTextContent('/api/domains/7/health-report');
	});

	it('keeps an unfinished key visible after a failed grant and never blindly creates another', async () => {
		const { calls } = renderApp(<AgentConnectionsSection />, {
			routes: {
				...connections,
				'GET /api/access': { ...empty, products: [{ id: 'p', name: 'Product' }] },
				'GET /api/resources': { domains: [{ id: 7, domain: 'mail.example.com', mappedProductIds: ['p'] }] },
				'POST /api/access/principals': { id: 'partial1' },
				'POST /api/access/grants': fail(400, 'grant rejected'),
				'DELETE /api/access/principals/partial1': { ok: true },
			},
		});
		const user = userEvent.setup();
		await openKeys(user);
		await user.selectOptions(screen.getByLabelText('Group'), 'p');
		await user.click(within(screen.getByRole('group', { name: 'Domains this key may see' })).getByRole('checkbox', { name: 'mail.example.com' }));
		await user.type(screen.getByLabelText('Key name'), 'Worker');
		await user.click(screen.getByRole('button', { name: 'Create key' }));
		expect(await screen.findByText(/Creating “Worker” stopped partway \(identity partial1\)/)).toBeInTheDocument();
		expect(screen.getByText('grant rejected')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create key' })).toBeDisabled();
		expect(calls.filter((c) => c.path === '/api/access/principals').length).toBe(1);
		await user.click(screen.getByRole('button', { name: 'Remove the unfinished key' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/access/principals/partial1')).toBe(true));
	});

	it('creates a replacement before the owner confirms, then revokes the old key', async () => {
		const { calls } = renderApp(<AgentConnectionsSection />, {
			routes: {
				...connections,
				'GET /api/resources': { domains: [] },
				'GET /api/access': {
					...empty,
					principals: [{ id: 'p', name: 'Worker', kind: 'service', disabled_at: null }],
					credentials: [{ id: 'old', principal_id: 'p', name: 'Worker key', prefix: 'ias_old', expires_at: 9999999999, revoked_at: null }],
				},
				'POST /api/access/credentials': { id: 'new', key: 'ias_replacement', prefix: 'ias_rep' },
				'DELETE /api/access/credentials/old': { ok: true },
			},
		});
		const user = userEvent.setup();
		await openKeys(user);
		expect(screen.getByRole('button', { name: TITLE })).toHaveAccessibleName(/1 active key/);
		await user.click(screen.getByRole('button', { name: 'Replace Worker key' }));
		await screen.findByLabelText('New key');
		expect(screen.getByText('The old key keeps working until you confirm the new one is saved.')).toBeInTheDocument();
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		await user.click(screen.getByRole('button', { name: 'I saved the new key, revoke the old one' }));
		await waitFor(() => expect(calls.some((c) => c.path === '/api/access/credentials/old' && c.method === 'DELETE')).toBe(true));
	});

	it('revokes a key only after confirmation', async () => {
		const { calls } = renderApp(<AgentConnectionsSection />, {
			routes: {
				...connections,
				'GET /api/resources': { domains: [{ id: 7, domain: 'mail.example.com', mappedProductIds: ['p'] }] },
				'GET /api/access': {
					...empty,
					products: [{ id: 'p', name: 'Store' }],
					principals: [{ id: 'p1', name: 'Nightly check', kind: 'service', disabled_at: null }],
					credentials: [{ id: 'c1', principal_id: 'p1', name: 'Nightly check', prefix: 'ias_abc', expires_at: 9999999999, revoked_at: null }],
					grants: [{ id: 'g1', principal_id: 'p1', domain: 'mail.example.com', actions: '["resources:read","reports:read"]', expires_at: 9999999999, revoked_at: null }],
				},
				'DELETE /api/access/credentials/c1': { ok: true },
			},
		});
		const user = userEvent.setup();
		await openKeys(user);
		expect(screen.getByText('See its domains · Read email health reports')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Revoke Nightly check' }));
		const dialog = await screen.findByRole('dialog');
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		await user.click(within(dialog).getByRole('button', { name: 'Revoke key' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/access/credentials/c1')).toBe(true));
	});

	it('does not offer access keys to an admin', async () => {
		const { calls } = renderApp(
			<>
				<AgentConnectionsSection />
				<MetricConnectionsSection />
			</>,
			{ role: 'admin', routes: connections },
		);
		await screen.findByText('Only a workspace owner can create access keys for scripts and services.');
		expect(screen.queryByRole('button', { name: TITLE })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Create group' })).not.toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/access' || c.path.startsWith('/api/metrics'))).toBe(false);
	});

	it('revokes a browser-approved agent only after confirmation', async () => {
		const { calls } = renderApp(<AgentConnectionsSection />, {
			role: 'admin',
			routes: {
				'GET /api/mcp/connections': { connections: [{ principalId: 'a1', name: 'Desk agent', workspaceId: 'ws_default', createdAt: 1, expiresAt: 9999999999, lastUsedAt: null }] },
				'DELETE /api/mcp/connections/a1': { ok: true },
			},
		});
		const user = userEvent.setup();
		await user.click(await screen.findByRole('button', { name: 'Revoke Desk agent' }));
		await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke agent' }));
		await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/mcp/connections/a1')).toBe(true));
	});

	it('shows the endpoint and points to Agents for the steps: no second copy of them, no plugin', async () => {
		for (const [hosted, label] of [[false, "This installation's MCP endpoint"], [true, 'Agent address']] as const) {
			const { unmount } = renderApp(<AgentConnectionsSection />, { status: hosted ? { mode: 'saas' } : undefined, routes: connections });
			expect(await screen.findByLabelText(label)).toBeInTheDocument();
			expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/agents');
			expect(document.body.textContent).toContain('How to connect Claude, ChatGPT, Cursor or VS Code');
			expect(document.body.textContent).not.toMatch(/plugin|Reload your client|Restart the agent|Call whoami/i);
			expect(document.querySelector('ol')).toBeNull();
			unmount();
		}
	});

	it('lists each approved app by name, with what it can reach, when it was approved and last used, and whether it is verified', async () => {
		const day = 1_700_000_000;
		renderApp(<AgentConnectionsSection />, {
			role: 'admin',
			routes: {
				'GET /api/mcp/connections': {
					connections: [
						{ principalId: 'a1', name: 'Cursor', workspaceId: 'ws_default', workspaceName: 'Acme', createdAt: day, expiresAt: day + 7 * 86400, lastUsedAt: day + 3600, verified: false, access: { workspaces: ['Acme'], domains: ['a.example', 'b.example', 'c.example', 'd.example', 'e.example', 'f.example', 'g.example'], products: ['Receipts'], actions: ['resources:read', 'reports:read'] } },
						{ principalId: 'a2', name: 'Document assistant', workspaceId: 'ws_default', workspaceName: 'Acme', createdAt: day, expiresAt: day + 86400, lastUsedAt: null, verified: true, verifiedHost: 'cimd.example', access: { workspaces: ['Acme'], domains: ['a.example'], products: [], actions: ['diagnostics:run'] } },
						{ principalId: 'a3', name: 'Old one', workspaceId: 'ws_default', createdAt: day, expiresAt: day + 86400, revoked: true },
					],
				},
			},
		});
		const cursor = (await screen.findByText('Cursor')).closest('li')!;
		expect(within(cursor).getByText('Not verified')).toBeInTheDocument();
		expect(within(cursor).getByText('a.example, b.example, c.example, d.example, e.example and 2 more (groups: Receipts)')).toBeInTheDocument();
		expect(within(cursor).getByText('See its domains, Read email health reports')).toBeInTheDocument();
		expect(within(cursor).getByText('Acme')).toBeInTheDocument();
		expect(within(cursor).queryByText('Not used yet')).not.toBeInTheDocument();
		const doc = screen.getByText('Document assistant').closest('li')!;
		expect(within(doc).queryByText('Not verified')).not.toBeInTheDocument();
		expect(within(doc).getByText('cimd.example')).toBeInTheDocument();
		expect(within(doc).getByText('Run live DNS checks')).toBeInTheDocument();
		expect(within(doc).getByText('Not used yet')).toBeInTheDocument();
		const old = screen.getByText('Old one').closest('li')!;
		expect(within(old).getByText('Revoked')).toBeInTheDocument();
		expect(within(old).queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument();
	});

	it('shows unconfigured Google as unavailable and disables consent and sync controls', async () => {
		renderApp(<MetricConnectionsSection />, {
			routes: { 'GET /api/metrics/google/connections': { configured: false, connections: [{ domainId: 7, domain: 'mail.example.com', status: 'not_connected' }] } },
		});
		expect(await screen.findByRole('status')).toHaveTextContent('not configured');
		expect(screen.getByRole('button', { name: 'Connect Google for mail.example.com' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Sync mail.example.com' })).toBeDisabled();
	});
});
