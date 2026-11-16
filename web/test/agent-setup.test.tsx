import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { AgentSetupPage } from '../src/pages/agent/AgentSetupPage';
import { AGENT_CLIENTS, canConnect } from '../src/lib/agent-clients';
import { SetupCheck } from '../src/components/SetupCheck';
import { FIRST_PROMPT } from '../src/lib/instance';
import { me, renderApp } from './render';

const URL_ = 'https://mail.example.com/mcp';
const status = (dynamic_registration: boolean, metadata_documents: boolean) => ({ 'GET /api/agents/status': { available: true, server_url: URL_, dynamic_registration, metadata_documents } });
const ready = status(true, true);
const notReady = { 'GET /api/agents/status': { available: false, server_url: null, dynamic_registration: false, metadata_documents: false } };
const owner = { 'GET /api/me': { ...me('owner'), instance_owner: true } };
const preflight = (items: unknown[]) => ({ 'GET /api/instance/preflight': { mode: 'self-host', agents: { available: false, server_url: null }, items } });

describe('Agents page', () => {
	it('shows what an agent can do, the server URL, a first prompt, where to revoke, and what it can never do', async () => {
		renderApp(<AgentSetupPage />, { routes: ready });
		expect((await screen.findAllByText('https://mail.example.com/mcp')).length).toBeGreaterThan(0);
		expect(screen.getByRole('heading', { name: 'What an agent can do here' })).toBeInTheDocument();
		expect(screen.getByText(FIRST_PROMPT)).toBeInTheDocument();
		expect(FIRST_PROMPT).toMatch(/whoami/);
		expect(FIRST_PROMPT).toMatch(/Don't change anything yourself/);
		expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Open your connections' })).toHaveAttribute('href', '/settings');
		const never = screen.getByRole('heading', { name: 'What an agent can never do here' }).closest('section')!;
		expect(within(never).getByText('Change your DNS records')).toBeInTheDocument();
		expect(within(never).getByText('Tighten your DMARC policy to quarantine or reject')).toBeInTheDocument();
	});

	it("keeps every assistant's steps in one list, each saying what it needs", () => {
		expect(AGENT_CLIENTS.map((c) => [c.client, c.needs])).toEqual([['Claude', 'either'], ['ChatGPT', 'either'], ['Cursor', 'dcr'], ['VS Code', 'either']]);
		for (const c of AGENT_CLIENTS) expect(c.steps.join(' ')).toContain('{url}');
		expect(canConnect(AGENT_CLIENTS[2]!, { dynamic_registration: false, metadata_documents: true })).toBe(false);
		expect(canConnect(AGENT_CLIENTS[0]!, { dynamic_registration: false, metadata_documents: true })).toBe(true);
		expect(canConnect(AGENT_CLIENTS[0]!, { dynamic_registration: true, metadata_documents: false })).toBe(true);
		expect(canConnect(AGENT_CLIENTS[0]!, { dynamic_registration: false, metadata_documents: false })).toBe(false);
	});

	it('with registration on, every assistant can connect and its steps carry the server URL', async () => {
		renderApp(<AgentSetupPage />, { routes: ready });
		expect(await screen.findByText('Every assistant below can connect to this instance.')).toBeInTheDocument();
		for (const c of AGENT_CLIENTS) {
			const toggle = screen.getByRole('button', { name: new RegExp(`^${c.client}.*Can connect here`) });
			expect(toggle).toHaveAttribute('aria-expanded', 'false');
		}
		const user = userEvent.setup();
		await user.click(screen.getByRole('button', { name: /^Cursor/ }));
		const steps = screen.getByRole('button', { name: /^Cursor/ }).closest('section')!;
		expect(within(steps).getByText(URL_)).toBeInTheDocument();
		expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
		expect(screen.queryByText(/MCP_DCR_ENABLED/)).not.toBeInTheDocument();
	});

	it('with registration off, says which assistants cannot connect yet, and tells only the owner the one setting', async () => {
		renderApp(<AgentSetupPage />, { role: 'member', routes: status(false, true) });
		expect(await screen.findByText("Claude, ChatGPT, VS Code can connect here. Cursor can't yet.")).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /^Cursor.*Not yet/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /^Claude.*Can connect here/ })).toBeInTheDocument();
		expect(document.body.textContent).toMatch(/Cursor needs the person who runs this instance to allow apps to register themselves/);
		expect(document.body.textContent).not.toMatch(/MCP_DCR_ENABLED/);
	});

	it('shows the instance owner the setting that lets the others connect', async () => {
		renderApp(<AgentSetupPage />, { routes: { ...status(false, true), ...owner, ...preflight([]) } });
		expect(await screen.findByText(/set MCP_DCR_ENABLED to 1/)).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /The operator guide has the steps/ })).toHaveAttribute('href', expect.stringContaining('agent-operations.md#letting-apps-register-themselves'));
	});

	it('says plainly when no assistant can connect', async () => {
		renderApp(<AgentSetupPage />, { role: 'member', routes: status(false, false) });
		expect(await screen.findByText('No assistant can connect to this instance yet')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /^Claude/ })?.textContent).toMatch(/Not yet/);
	});

	it('tells someone who does not run the instance that agents are not set up, without settings names or a preflight request', async () => {
		const { calls } = renderApp(<AgentSetupPage />, { role: 'member', routes: notReady });
		expect(await screen.findByText("Agents can't connect to this instance yet")).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/OAUTH_KV|BETTER_AUTH_URL/);
		expect(screen.queryByText('https://mail.example.com/mcp')).not.toBeInTheDocument();
		expect(calls.some((c) => c.path === '/api/instance/preflight')).toBe(false);
	});

	it('tells the person who runs it exactly what to configure', async () => {
		renderApp(<AgentSetupPage />, {
			routes: { ...notReady, ...owner, ...preflight([{ id: 'oauth_storage', severity: 'action', setting: 'OAUTH_KV', message: 'No OAUTH_KV namespace is bound.' }, { id: 'booking_link', severity: 'note', setting: 'BOOKING_URL', message: 'No booking link.' }]) },
		});
		expect(await screen.findByText('No OAUTH_KV namespace is bound.')).toBeInTheDocument();
		expect(screen.queryByText('No booking link.')).not.toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'the operator guide' })).toHaveAttribute('href', expect.stringContaining('agent-operations.md'));
	});
});

describe('SetupCheck', () => {
	it('shows the owner a banner only while something needs action, with setting names and no values', async () => {
		renderApp(<SetupCheck compact />, { routes: { ...owner, ...preflight([{ id: 'bot_check', severity: 'action', setting: 'TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY', message: 'Sign-up is closed: the bot check is not configured.' }]) } });
		expect(await screen.findByText('One setting needs your attention')).toBeInTheDocument();
		expect(screen.getByText(/Only you see this/)).toBeInTheDocument();
		expect(screen.getByText('(TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY)')).toBeInTheDocument();
	});

	it('stays quiet for notes only', async () => {
		const { calls } = renderApp(<SetupCheck compact />, { routes: { ...owner, ...preflight([{ id: 'booking_link', severity: 'note', setting: 'BOOKING_URL', message: 'No booking link.' }]) } });
		await waitFor(() => expect(calls.some((c) => c.path === '/api/instance/preflight')).toBe(true));
		expect(screen.queryByText('No booking link.')).not.toBeInTheDocument();
	});

	it('never asks the server when the viewer does not run the instance', async () => {
		const { calls } = renderApp(<SetupCheck />, { role: 'admin' });
		await waitFor(() => expect(calls.some((c) => c.path === '/api/me')).toBe(true));
		await new Promise((r) => setTimeout(r, 50));
		expect(calls.some((c) => c.path === '/api/instance/preflight')).toBe(false);
	});

	it('in Settings, lists notes too, or says there is nothing to fix', async () => {
		renderApp(<SetupCheck />, { routes: { ...owner, ...preflight([]) } });
		expect(await screen.findByText('Nothing to fix')).toBeInTheDocument();
	});
});
