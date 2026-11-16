// The plan's screens the review asked about: the zone list of "Also in your Cloudflare account", the create-workspace dialog with the card notice, and the
// add path of a workspace whose payment did not go through.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateWorkspaceDialog } from '../src/components/CreateWorkspaceDialog';
import { CloudflareSuggestions } from '../src/components/domain/CloudflareSuggestions';
import { AddDomainPage } from '../src/pages/domains/AddDomainPage';
import type { PaidPreview, PlanView } from '../src/lib/plan';
import { renderApp } from './render';

afterEach(() => vi.unstubAllGlobals());

const UNIT = { amount: 500, currency: 'usd', interval: 'month' as const };
const CARD = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 };
const plan = (over: Partial<PlanView> = {}): PlanView => ({
	mode: 'free_one_domain', name: 'free', exempt: false, includes_free_domain: true, paid_available: true, help_url: null, units: 1, billable: 0, paused_units: 0, grandfathered: false, domains: [{ id: 1, name: 'one.example.com', billable: false, paused: false }],
	status: null, payment_problem: false, lapsed: false, pending: null, paused_domains: 0, resume_by_starting: false, cancel_at_period_end: false, period_end: null, interval: null, notice: null, can_manage: true, price: UNIT, ...over,
});
const billing = (p: PlanView = plan()) => ({ enabled: true, role: 'owner', can_manage: true, billing_email: 'o@x.co', has_customer: true, card_on_file: true, card: CARD, offer: null, offer_problem: null, orders: [], terms_url: null, refund_policy_url: null, plan: p });
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

describe('Also in your Cloudflare account', () => {
	const conn = { id: 'c1', label: 'Example Co', auth_type: 'oauth', status: 'active', status_detail: null, cf_account_id: 'a1', cf_account_name: 'Example Co', zones: [], scopes: [], accounts: [{ id: 'a1', name: 'Example Co' }] };
	const zone = (name: string, i: number) => ({ connection_id: 'c1', account_id: 'a1', account_name: 'Example Co', zone_id: `z${i}`, name, removed: false });
	const routes = (extra: Record<string, unknown> = {}) => ({
		'GET /api/billing': billing(),
		'GET /api/cloudflare/connections': { connections: [conn], oauth: { available: true, scopes: [], via_relay: false }, token_paste: false, encryption_configured: true, accounts: [] },
		'GET /api/cloudflare/suggestions': { dismissed: false, suggestions: [zone('b.org', 1), zone('c.net', 2), zone('d.io', 3)] },
		...extra,
	});

	it('the Add button states the count and the total once something is ticked, and leads to the one confirm with exactly those names', async () => {
		const onPaid = vi.fn();
		const { calls } = renderApp(<CloudflareSuggestions onPaid={onPaid} />, { status: { mode: 'saas' }, routes: routes({ 'GET /api/billing/domains/preview?domain=b.org&domain=d.io': { needs_confirm: true, reason: 'paid' } as Partial<PaidPreview> }) });
		await screen.findByText('b.org');
		expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
		await userEvent.click(screen.getByRole('checkbox', { name: 'b.org' }));
		expect(screen.getByRole('button', { name: 'Add 1: $5 a month' })).toBeEnabled();
		await userEvent.click(screen.getByRole('checkbox', { name: 'd.io' }));
		await userEvent.click(screen.getByRole('button', { name: 'Add 2: $10 a month' }));
		await waitFor(() => expect(onPaid).toHaveBeenCalledWith(['b.org', 'd.io']));
		expect(calls.some((c) => c.method === 'POST')).toBe(false); // nothing is bought by this click: the confirm is next
	});

	it('a zone the workspace holds is not in the list the server sends, so it is not on screen', async () => {
		renderApp(<CloudflareSuggestions />, { status: { mode: 'saas' }, routes: routes({ 'GET /api/cloudflare/suggestions': { dismissed: false, suggestions: [zone('b.org', 1)] } }) });
		await screen.findByText('b.org');
		expect(screen.queryByText('one.example.com')).toBeNull();
		expect(screen.getAllByRole('checkbox')).toHaveLength(1);
	});
});

describe('Create workspace with the card notice', () => {
	it('the dialog is about the card: at most 25 words above the button, and the generic description is gone', async () => {
		renderApp(<CreateWorkspaceDialog open onOpenChange={() => {}} />, {
			status: { mode: 'saas' },
			routes: { 'POST /api/workspaces': { __status: 402, body: { error: 'Add a card to create more workspaces.', code: 'workspace_needs_card', paid_available: true, help_url: null, unit_price: UNIT } } },
		});
		await userEvent.type(await screen.findByLabelText('Workspace name'), 'Lexgo');
		await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
		const button = await screen.findByRole('button', { name: 'Add a card to continue' });
		const dialog = screen.getByRole('dialog');
		const above = dialog.querySelector('form')!;
		const footer = button.parentElement!;
		const textAbove = above.textContent!.replace(footer.textContent!, '');
		expect(words(textAbove)).toBeLessThanOrEqual(25);
		expect(textAbove).toContain('Each domain in it is $5 a month. Cancel any time.');
		expect(within(dialog).queryByText(/A workspace keeps its own/)).toBeNull();
	});
	it('without the notice the description is still there', async () => {
		renderApp(<CreateWorkspaceDialog open onOpenChange={() => {}} />, { status: { mode: 'saas' } });
		expect(await screen.findByText(/A workspace keeps its own/)).toBeTruthy();
	});
});

describe('adding a domain while the last payment did not go through', () => {
	it('a typed domain that waits for its record says the payment problem and offers the card, not the TXT record or "your free plan covers one domain"', async () => {
		const open = vi.fn();
		vi.stubGlobal('open', open);
		renderApp(<AddDomainPage />, {
			status: { mode: 'saas' },
			routes: {
				'GET /api/billing': billing(plan({ name: 'payg', status: 'past_due', payment_problem: true, billable: 1, units: 2 })),
				'GET /api/cloudflare/connections': { connections: [], oauth: { available: false, scopes: [], via_relay: false }, token_paste: false, encryption_configured: true, accounts: [] },
				'POST /api/domains': { __status: 202, body: { pending: true, claim: { id: 4, domain: 'third.example.net', txt_name: '_readysetmail.third.example.net', txt_value: 'readysetmail-verify=x', status: 'pending' } } },
				'GET /api/billing/domains/preview?domain=third.example.net': { needs_confirm: false, reason: 'payment_problem', can_confirm: false, domains: ['third.example.net'], new_units: 1, unit_price: UNIT, charge_now: 0, next_invoice: null, then: null, plan_starts: false, no_charge: false, preview_failed: false, grandfather: null, proof: { state: 'unverified', domain: 'third.example.net', claim_id: 4, txt_name: '_readysetmail.third.example.net', txt_value: 'readysetmail-verify=x', reason: null } },
			},
		});
		await userEvent.type(await screen.findByLabelText('Your domain'), 'third.example.net');
		await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(await screen.findByText('Your last payment did not go through. Update your card to add more domains.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Update your card' })).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/TXT record|free plan covers one domain/);
	});
});
