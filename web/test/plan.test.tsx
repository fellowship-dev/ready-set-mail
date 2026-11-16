// The hosted plan in the dashboard: the sentences (every amount is the server's, taken from Stripe's preview), the paid-domain confirm, the plan card.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaidAdd } from '../src/components/billing/PaidAdd';
import { PlanCard } from '../src/components/billing/PlanCard';
import { confirmLabel, confirmSentence, invoiceMoney, planRequiredOf, usd, WORDS, type PaidPreview, type PlanView } from '../src/lib/plan';
import { ApiError } from '../src/lib/api';
import { fail, renderApp } from './render';

afterEach(() => vi.unstubAllGlobals());

const UNIT = { amount: 500, currency: 'usd', interval: 'month' as const };
const preview = (over: Partial<PaidPreview> = {}): PaidPreview => ({
	needs_confirm: true, domains: ['second.example.org'], new_units: 1, unit_price: UNIT, charge_now: 0, next_invoice: null, then: null, plan_starts: false, no_charge: false, preview_failed: false, can_confirm: true, grandfather: null, reason: 'paid',
	proof: { state: 'none', domain: null, claim_id: null, txt_name: null, txt_value: null, reason: null }, ...over,
});
const DEC16 = Date.UTC(2026, 11, 16) / 1000;
const CARD = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 };
const plan = (over: Partial<PlanView> = {}): PlanView => ({
	mode: 'free_one_domain', name: 'free', exempt: false, includes_free_domain: true, paid_available: true, help_url: null, units: 1, billable: 0, paused_units: 0, grandfathered: false, domains: [{ id: 1, name: 'one.example.com', billable: false, paused: false }],
	status: null, payment_problem: false, lapsed: false, pending: null, paused_domains: 0, resume_by_starting: false, cancel_at_period_end: false, period_end: null, interval: null, notice: null, can_manage: true, price: UNIT, ...over,
});
const billing = (over: Record<string, unknown> = {}, p: PlanView = plan()) => ({ enabled: true, role: 'owner', can_manage: true, billing_email: 'o@x.co', has_customer: true, card_on_file: true, card: CARD, offer: null, offer_problem: null, orders: [], terms_url: 'https://readysetmail.com/terms', refund_policy_url: null, plan: p, ...over });

describe('the words of the confirm: Stripe\'s numbers, never made up here', () => {
	it('with a subscription: the monthly price, from today, the next invoice with its date and amount, one proration sentence', () => {
		const p = preview({ next_invoice: { amount_due: 725, currency: 'usd', date: DEC16 } });
		expect(confirmSentence(p, 'Visa ···4242')).toEqual(['$5 a month for this domain, from today.', "Your next invoice on Dec 16 to Visa ···4242: $7.25 (this month's part plus the next).", 'Subdomains included. Cancel any time.']);
		expect(confirmLabel(p)).toBe('Add for $5 a month');
	});
	it('that starts the plan: what is charged now and the day of the next one, both Stripe\'s', () => {
		const p = preview({ plan_starts: true, charge_now: 500, then: { amount: 500, currency: 'usd', date: DEC16 } });
		expect(confirmSentence(p, 'Visa ···4242')).toEqual(['$5 now to Visa ···4242, then $5 a month from Dec 16.', 'Subdomains included. Cancel any time.']);
	});
	it('several domains: the total is not a sum made here', () => {
		const p = preview({ plan_starts: true, charge_now: 1500, then: { amount: 1500, currency: 'usd', date: DEC16 }, domains: ['a.com', 'b.com', 'c.com'] });
		expect(confirmSentence(p, 'Visa ···4242', 3)[0]).toBe('$15 now to Visa ···4242, then $15 a month from Dec 16.');
		expect(confirmLabel(p, 3)).toBe('Add 3 domains');
		expect(confirmSentence(preview({ next_invoice: { amount_due: 1000, currency: 'usd', date: null } }), 'Visa ···4242', 2)[0]).toBe('$5 a month for each of these 2 domains, from today.');
	});
	it('when Stripe could not be asked: the plain price and "billed with your next invoice", or no amount at all where the add charges now', () => {
		expect(confirmSentence(preview({ preview_failed: true }), 'Visa ···4242')[0]).toBe('$5 a month for this domain, billed with your next invoice.');
		expect(confirmSentence(preview({ plan_starts: true, charge_now: null, preview_failed: true, can_confirm: false }), 'Visa ···4242')).toEqual([WORDS.noPreview]);
	});
	it('the explicit start of an ordinary workspace says nothing is charged', () => {
		expect(confirmSentence(preview({ plan_starts: true, no_charge: true, charge_now: 0 }), 'Visa ···4242')[0]).toBe('No charge until you add a domain beyond your free one.');
	});
	it('money: whole amounts without cents, an invoice always with', () => {
		expect([usd(500), usd(550), invoiceMoney(500)]).toEqual(['$5', '$5.50', '$5.00']);
	});
	it('a plan_required answer is read for what it says', () => {
		const e = new ApiError(402, 'Your free plan covers one domain and all its subdomains.', { code: 'plan_required', paid_available: true, help_url: 'https://cal.example.com/max', domain: 'x.com' });
		expect(planRequiredOf(e)).toMatchObject({ paidAvailable: true, helpUrl: 'https://cal.example.com/max', domain: 'x.com' });
		expect(planRequiredOf(new ApiError(403, 'no', { code: 'plan_limit' }))).toBeNull();
	});
});

describe('the paid-domain confirm', () => {
	const run = (b: Record<string, unknown>, p: PaidPreview, extra: Record<string, unknown> = {}) =>
		renderApp(<PaidAdd domains={['second.example.org']} returnPath="/add?domain=second.example.org" onAdded={vi.fn()} onCancel={vi.fn()} />, { status: { mode: 'saas' }, routes: { 'GET /api/billing': b, 'GET /api/billing/domains/preview?domain=second.example.org': p, ...extra } });

	it('with a card: the sentences, ONE button, and the click sends the price and the charge the person saw, never a quantity', async () => {
		const added = vi.fn();
		const p = preview({ plan_starts: true, charge_now: 500, then: { amount: 500, currency: 'usd', date: DEC16 } });
		const { calls } = renderApp(<PaidAdd domains={['second.example.org']} returnPath="/add" onAdded={added} />, {
			status: { mode: 'saas' },
			routes: { 'GET /api/billing': billing(), 'GET /api/billing/domains/preview?domain=second.example.org': p, 'POST /api/billing/domains': { added: [{ domain: 'second.example.org', domain_id: 2 }], pending: [], resumed: [], failed: [], payment: null } },
		});
		expect(await screen.findByText('$5 now to Visa ···4242, then $5 a month from Dec 16.')).toBeTruthy();
		expect(screen.getAllByRole('button').filter((b) => /Add for|Add a card/.test(b.textContent ?? ''))).toHaveLength(1);
		await userEvent.click(screen.getByRole('button', { name: 'Add for $5 a month' }));
		await waitFor(() => expect(added).toHaveBeenCalled());
		const post = calls.find((c) => c.method === 'POST' && c.path === '/api/billing/domains')!;
		expect(post.body).toEqual({ domain: 'second.example.org', expected_amount: 500, expected_currency: 'usd', expected_charge: 500 });
	});

	it('without a card the primary button is "Add a card to continue", with the plain price and no amount to pay', async () => {
		run(billing({ card_on_file: false, card: null }), preview({ plan_starts: true, preview_failed: true, charge_now: null, can_confirm: false }));
		expect(await screen.findByText('$5 a month for this domain. Subdomains included. Cancel any time.')).toBeTruthy();
		expect(screen.getByText('Add a card first: you see the exact amount before you pay.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Add a card to continue' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Add for/ })).toBeNull();
	});

	it('a preview that could not be read: the button cannot be pressed (never a guessed amount)', async () => {
		run(billing(), preview({ plan_starts: true, preview_failed: true, charge_now: null, can_confirm: false }));
		expect(await screen.findByText(WORDS.noPreview)).toBeTruthy();
		expect((screen.getByRole('button', { name: 'Add for $5 a month' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('a declined card says so in the plan\'s words and offers the card, not a code', async () => {
		const p = preview({ plan_starts: true, charge_now: 500, then: { amount: 500, currency: 'usd', date: DEC16 } });
		run(billing(), p, { 'POST /api/billing/domains': { __status: 402, body: { code: 'payment_failed', error: WORDS.declined, action: 'update_card' } } });
		await screen.findByText('$5 now to Visa ···4242, then $5 a month from Dec 16.');
		await userEvent.click(screen.getByRole('button', { name: 'Add for $5 a month' }));
		expect(await screen.findByText(/Your card was declined\. Use another card\. Nothing was added\./)).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Change card' })).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/card_declined|generic_decline|402/);
	});

	it('a bank that needs to confirm leaves the domain pending, with the link, and waits', async () => {
		const open = vi.fn();
		vi.stubGlobal('open', open);
		run(billing(), preview({ plan_starts: true, charge_now: 500, then: { amount: 500, currency: 'usd', date: DEC16 } }), { 'POST /api/billing/domains': { added: [{ domain: 'second.example.org', domain_id: 2 }], pending: [], resumed: [], failed: [], payment: { state: 'requires_action', action_url: 'https://stripe.fake/i/in_1' } } });
		await screen.findByText('$5 now to Visa ···4242, then $5 a month from Dec 16.');
		await userEvent.click(screen.getByRole('button', { name: 'Add for $5 a month' }));
		expect(await screen.findByText("Waiting for your bank's confirmation")).toBeTruthy();
		expect(open).toHaveBeenCalledWith('https://stripe.fake/i/in_1', '_blank', 'noopener,noreferrer');
		expect(screen.getByRole('link', { name: /Open the confirmation page again/ }).getAttribute('href')).toBe('https://stripe.fake/i/in_1');
	});

	it('a domain whose record is not there yet: the record first, then the check, and no money asked', async () => {
		run(billing(), preview({ proof: { state: 'unverified', domain: 'second.example.org', claim_id: 3, txt_name: '_readysetmail.second.example.org', txt_value: 'readysetmail-verify=abc', reason: 'not found' } }));
		expect(await screen.findByText(/Add this TXT record where you manage second\.example\.org/)).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Check the record' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Add for/ })).toBeNull();
	});

	it('anyone but the owner is told whom to ask, and nothing else', async () => {
		renderApp(<PaidAdd domains={['second.example.org']} returnPath="/add" onAdded={vi.fn()} />, { role: 'member', status: { mode: 'saas' }, routes: { 'GET /api/billing': billing({ role: 'member', can_manage: false, card: undefined }, plan({ can_manage: false, ask_owner: true, price: undefined })) } });
		expect(await screen.findByText(WORDS.askOwner)).toBeTruthy();
		expect(screen.queryByRole('button')).toBeNull();
	});

	it('the grandfather choice: the confirm says what the workspace already holds, and the domains keep working either way', async () => {
		run(billing(), preview({ grandfather: { units: 3, billable_now: 2, billable_after: 3 }, next_invoice: { amount_due: 1500, currency: 'usd', date: DEC16 } }));
		expect(await screen.findByText(/This workspace already holds 3 domains, and only one is free\./)).toBeTruthy();
	});

	it('a payment problem pauses adding with the plain sentence and the card button', async () => {
		run(billing({}, plan({ name: 'payg', payment_problem: true })), preview({ needs_confirm: false, reason: 'payment_problem', can_confirm: false }));
		expect(await screen.findByText(WORDS.paymentProblem)).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Update your card' })).toBeTruthy();
	});
});

describe('Settings → Billing, the plan', () => {
	const show = (p: PlanView, b: Record<string, unknown> = {}, role: 'owner' | 'admin' | 'member' = 'owner', routes: Record<string, unknown> = {}) =>
		renderApp(<PlanCard plan={p} billing={billing(b, p) as never} />, { role, status: { mode: 'saas' }, routes: { 'GET /api/billing': billing(b, p), ...routes } });

	it('free: its name, what it includes, one action, no pricing table', async () => {
		show(plan());
		expect(await screen.findByRole('heading', { name: 'Free' })).toBeTruthy();
		expect(screen.getByText(WORDS.freeIncludes)).toBeTruthy();
		expect(screen.getByText('More domains are pay as you go: $5 a month for each. Cancel any time.')).toBeTruthy();
		expect(screen.getAllByRole('button')).toHaveLength(1);
		expect(screen.getByRole('button', { name: 'Start pay as you go' })).toBeTruthy();
		expect(document.querySelector('table')).toBeNull();
	});
	it('pay as you go with nothing billed yet', async () => {
		show(plan({ name: 'payg', status: 'active', quantity: 0, billable: 0 }));
		expect(await screen.findByRole('heading', { name: 'Pay as you go' })).toBeTruthy();
		expect(screen.getByText('Your first domain is free. Each domain beyond it is $5 a month. Subdomains are included.')).toBeTruthy();
		expect(screen.getByText('None yet')).toBeTruthy();
		expect(screen.getByText('Nothing to pay yet')).toBeTruthy();
	});
	it('pay as you go with domains: the billed domains, the count, and Stripe\'s next invoice', async () => {
		show(plan({ name: 'payg', status: 'active', quantity: 2, billable: 2, units: 3, next_invoice: { amount_due: 1000, currency: 'usd', date: DEC16 }, domains: [{ id: 1, name: 'one.example.com', billable: false, paused: false }, { id: 2, name: 'two.example.org', billable: true, paused: false }, { id: 3, name: 'three.example.net', billable: true, paused: false }] }));
		expect(await screen.findByText('two.example.org')).toBeTruthy();
		expect(screen.queryByText('one.example.com')).toBeNull(); // the free one is not a line of the bill
		expect(screen.getByText('2 × $5 a month')).toBeTruthy();
		expect(screen.getByText(/^Dec 16, 2026: \$10\.00$/)).toBeTruthy();
	});
	it('a payment that did not go through: one action, the card', async () => {
		show(plan({ name: 'payg', status: 'past_due', payment_problem: true, billable: 1, quantity: 1 }));
		expect(await screen.findAllByText(/Your last payment did not go through/)).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Update your card' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Start pay as you go/ })).toBeNull();
	});
	it('a renewal that needs the bank: the one action is the confirmation page', async () => {
		show(plan({ name: 'payg', status: 'past_due', action_required_url: 'https://stripe.fake/i/in_9', billable: 1, quantity: 1 }));
		expect((await screen.findByRole('link', { name: /Confirm the payment/ })).getAttribute('href')).toBe('https://stripe.fake/i/in_9');
	});
	it('cancelling at the period end: when it ends, and that the domains keep working until then', async () => {
		show(plan({ name: 'payg', status: 'active', cancel_at_period_end: true, period_end: DEC16, billable: 1, quantity: 1 }));
		expect(await screen.findByText(/^Dec 16, 2026\. Your domains keep working until then\.$/)).toBeTruthy();
	});
	it('lapsed: free again, the domains beyond the free one are paused, one way back', async () => {
		show(plan({ lapsed: true, paused_domains: 2, resume_by_starting: true }));
		expect(await screen.findByText(/Pay as you go ended\. Domains beyond your free one are paused: you can read and export them\./)).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Start pay as you go again' })).toBeTruthy();
	});
	it('a member or admin reads the plan and is told whom to ask; nothing to press', async () => {
		show(plan({ can_manage: false, ask_owner: true, price: undefined }), { role: 'member', can_manage: false }, 'member');
		expect(await screen.findByText(WORDS.askOwner)).toBeTruthy();
		expect(screen.queryByRole('button')).toBeNull();
	});
	it('the operator\'s workspace has no plan', async () => {
		show(plan({ exempt: true }));
		expect(await screen.findByText('No plan applies to this workspace.')).toBeTruthy();
	});
	it('without the paid path it says "talk to us" and offers nothing to buy', async () => {
		show(plan({ paid_available: false }));
		expect(await screen.findByText('More domains: talk to us.')).toBeTruthy();
		expect(screen.queryByRole('button')).toBeNull();
	});
});

void fail;
