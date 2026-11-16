import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { EmailSection } from '../src/pages/settings/EmailSection';
import { renderApp } from './render';

const view = (over: Record<string, unknown> = {}) => ({ role: 'owner', summary: { offered: true, enabled: true }, tips: { offered: true, enabled: true }, ...over });

describe('Settings -> Email', () => {
	it('hosted owner: two switches with one-line descriptions, each as the server says', async () => {
		renderApp(<EmailSection />, { status: { mode: 'saas' }, routes: { 'GET /api/email-preferences': view({ tips: { offered: true, enabled: false } }) } });
		expect(await screen.findByRole('heading', { name: 'Email' })).toBeInTheDocument();
		const summary = await screen.findByRole('switch', { name: 'Weekly summary' });
		const tips = screen.getByRole('switch', { name: 'Tips about your domains' });
		expect(summary).toBeChecked();
		expect(tips).not.toBeChecked();
		expect(summary).toHaveAccessibleDescription(/last week's DMARC reports/);
	});

	it('the tips choice is not listed when this instance sends no tips', async () => {
		renderApp(<EmailSection />, { status: { mode: 'saas' }, routes: { 'GET /api/email-preferences': view({ tips: { offered: false, enabled: false } }) } });
		expect(await screen.findByRole('switch', { name: 'Weekly summary' })).toBeInTheDocument();
		expect(screen.queryByRole('switch', { name: 'Tips about your domains' })).toBeNull();
		expect(screen.queryByText('Tips about your domains')).toBeNull();
	});

	it('the tips choice is listed, and off, when the instance sends tips and the person has not chosen', async () => {
		renderApp(<EmailSection />, { status: { mode: 'saas' }, routes: { 'GET /api/email-preferences': view({ tips: { offered: true, enabled: false } }) } });
		expect(await screen.findByRole('switch', { name: 'Tips about your domains' })).not.toBeChecked();
	});

	it('turning a switch off saves that one choice and shows the answer', async () => {
		const { calls } = renderApp(<EmailSection />, {
			status: { mode: 'saas' },
			routes: {
				'GET /api/email-preferences': view(),
				'PUT /api/email-preferences': ({ body }: { body: { kind: string; enabled: boolean } }) => view({ [body.kind]: { offered: true, enabled: body.enabled } }),
			},
		});
		await userEvent.click(await screen.findByRole('switch', { name: 'Weekly summary' }));
		await waitFor(() => expect(screen.getByRole('switch', { name: 'Weekly summary' })).not.toBeChecked());
		expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ kind: 'summary', enabled: false }]);
		expect(screen.getByRole('switch', { name: 'Tips about your domains' })).toBeChecked();
	});

	it('a member is offered neither, so the section is not there', async () => {
		renderApp(<EmailSection />, { role: 'member', status: { mode: 'saas' }, routes: { 'GET /api/email-preferences': view({ role: 'member', summary: { offered: false, enabled: false }, tips: { offered: false, enabled: false } }) } });
		await waitFor(() => expect(screen.queryByRole('switch')).toBeNull());
		expect(screen.queryByRole('heading', { name: 'Email' })).toBeNull();
	});

	it('self-host: nothing, and the server is not asked', async () => {
		const { calls } = renderApp(<EmailSection />, { status: { mode: 'self-host' } });
		await waitFor(() => expect(calls.some((c) => c.path === '/api/me')).toBe(true));
		expect(screen.queryByRole('heading', { name: 'Email' })).toBeNull();
		expect(calls.some((c) => c.path.startsWith('/api/email-preferences'))).toBe(false);
	});

	it('says so when saving fails', async () => {
		const { calls } = renderApp(<EmailSection />, {
			status: { mode: 'saas' },
			routes: { 'GET /api/email-preferences': view(), 'PUT /api/email-preferences': { __status: 500, body: { error: 'Could not save' } } },
		});
		await userEvent.click(await screen.findByRole('switch', { name: 'Tips about your domains' }));
		expect(await screen.findByText('Could not save')).toBeInTheDocument();
		expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
	});
});
