import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainDetailPage } from '../src/pages/domains/DomainDetailPage';
import { SettingsPage } from '../src/pages/settings/SettingsPage';
import { OrdersPage } from '../src/pages/operator/OrdersPage';
import { fail, renderApp } from './render';

afterEach(() => vi.unstubAllGlobals());

// ── A domain with something to fix, and one that is fine ────────────────────
const domain = { id: 1, domain: 'example.com', dmarc_policy: 'quarantine', rua_address: 'r@reports.test', parent_id: null, created_at: 1700000000, alerts_enabled: 1, is_default: 0 };
const current = 'v=DMARC1; p=quarantine; rua=mailto:someone@else.test';
const rollout = { current_policy: 'quarantine', current_pct: 100, current_testing: false, current_record: current, current_step_index: 1, total_steps: 5, next_step: { policy: 'reject', testing: true }, next_step_note: 'x', dns_preview: 'v=DMARC1; p=reject; rua=mailto:r@reports.test', pass_rate: 97, blocked: false, block_reason: null, has_unknown_senders: false, behind_schedule: false, recommended_policy: null, recommended_pct: null };
const onboarding = { domain_id: 1, domain: 'example.com', rua_address: 'r@reports.test', cf_available: true, dmarc: { found: true, has_our_rua: false, current_record: current }, spf: { record: 'v=spf1 include:_spf.google.com -all', lookup_count: 4, flattening_active: false }, dkim: { selectors: [{ name: 'google._domainkey.example.com', record: 'v=DKIM1; k=rsa; p=AAA' }], source: 'doh' }, routing: { mx_found: true, destination_verified: true, reports_domain: null, admin_email: null } };
const now = Math.floor(Date.now() / 1000);
const summary = { domain_id: 1, domain: 'example.com', dmarc_policy: 'quarantine', spf_record: 'v=spf1 include:_spf.google.com -all', dns_checked_at: now - 60, dns_check_attempted_at: now - 60, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok', total_messages: 100, pass_messages: 97, fail_messages: 3, dkim_total: 0, dkim_pass: 0, spf_total: 0, spf_pass: 0, mta_sts_enabled: 0, mta_sts_mode: null, spf_lookup_count: 4, dmarc_pct: 100, dmarc_p: 'quarantine', dmarc_sp: null, dmarc_rua: 0 };
const fineRecord = 'v=DMARC1; p=reject; rua=mailto:r@reports.test';
const fine = {
	'GET /api/domains': { domains: [{ ...domain, dmarc_policy: 'reject' }] },
	'GET /api/domains/1/check-summary': { ...summary, dmarc_policy: 'reject', dmarc_p: 'reject', dmarc_rua: 1 },
	'GET /api/domains/1/dns-check': { found: true, has_rua: true, current_record: fineRecord, cf_managed: true },
	'GET /api/domains/1/onboarding-status': { ...onboarding, dmarc: { found: true, has_our_rua: true, current_record: fineRecord } },
	'GET /api/domains/1/rollout-next': { ...rollout, current_policy: 'reject', current_record: fineRecord, next_step: null },
};

const OFFER = { id: 'fix-one-domain', name: 'Fix one domain', scope: 'The authentication part of Fix it, for one domain: every authorized sender confirmed, SPF and DKIM fixed, DMARC moved to reject.', amount: 14900, currency: 'usd', refund_rule: 'Until we send the written note that the domain is done, you can ask for the full fee back.', next_steps: 'We will write to you about the access the work needs. The work starts when you have given it, and ends with our written note that the domain is done.' };
const CARD = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 };
const order = (over: Record<string, unknown> = {}) => ({ id: 'ord_a', domain: 'example.com', domain_id: 1, offer: 'fix-one-domain', amount: 14900, amount_paid: null, currency: 'usd', payment_review: false, status: 'pending', amount_refunded: 0, buyer_email: 'owner@example.com', failure_message: null, action_required: false, action_url: null, created_at: 1_800_000_000, paid_at: null, started_at: null, done_at: null, refunded_at: null, failed_at: null, ...over });
const links = { terms_url: 'https://readysetmail.com/terms', refund_policy_url: 'https://readysetmail.com/refund-policy' };
const billing = (over: Record<string, unknown> = {}) => ({ enabled: true, role: 'owner', can_manage: true, billing_email: 'owner@example.com', has_customer: true, card_on_file: true, card: CARD, offer: OFFER, offer_problem: null, orders: [], ...links, ...over });
const domainBilling = (over: Record<string, unknown> = {}) => ({ domain: { id: 1, name: 'example.com' }, role: 'owner', can_buy: true, has_customer: true, card_on_file: true, card: CARD, billing_email: 'owner@example.com', offer: OFFER, offer_problem: null, open_order: null, orders: [], ...links, ...over });

const base = {
	'GET /api/domains': { domains: [domain] },
	'GET /api/domains/1/check-summary': summary,
	'GET /api/domains/1/stats': { domain: 'example.com', days: 7, stats: [{ day: '2026-10-20', total: 100, passed: 97, failed: 3 }] },
	'GET /api/domains/1/sources': { sources: [], one_check: { sources: 0, messages: 0 }, not_recorded: { sources: 0, messages: 0 } },
	'GET /api/domains/1/wizard-state': { domain: 'complete', spf: 'complete', dkim: 'complete', dmarc: 'complete', routing: 'complete' },
	'GET /api/domains/1/dns-check': { found: true, has_rua: false, current_record: current, cf_managed: true },
	'GET /api/domains/1/onboarding-status': onboarding,
	'GET /api/domains/1/rollout-next': rollout,
	'GET /api/domains/1/spf-flatten': { available: false, config: null, lookup_count: null },
	'GET /api/domains/1/mta-sts': { available: false, config: null, summary: null },
};
const hostedRoutes = (over: Record<string, unknown> = {}) => ({ ...base, 'GET /api/billing': billing(), 'GET /api/billing/domains/1': domainBilling(), ...over });

function Where() {
	const l = useLocation();
	return <output data-testid="where">{l.pathname + l.search}</output>;
}
const page = (opts: Parameters<typeof renderApp>[1]) =>
	renderApp(
		<>
			<Routes>
				<Route path="/domains/:id" element={<DomainDetailPage />} />
			</Routes>
			<Where />
		</>,
		{ route: '/domains/1', status: { mode: 'saas' }, ...opts },
	);
const dialogOf = async () => within(await screen.findByRole('dialog'));
const offerButton = () => screen.findByRole('button', { name: 'Have us fix this domain: $149 USD' });

describe('the offer on a domain page', () => {
	it('is a quiet secondary action in "Do this next", once, with the price from the API', async () => {
		page({ routes: hostedRoutes() });
		const button = await offerButton();
		expect(button.className).not.toContain('bg-brand');
		const doNext = screen.getByRole('heading', { name: 'Do this next' });
		const offerTitle = screen.getByRole('heading', { name: 'Fix one domain' });
		expect(doNext.compareDocumentPosition(offerTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getByRole('heading', { name: /Where it stands/ }).compareDocumentPosition(offerTitle) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
		expect(screen.getAllByText(OFFER.scope)).toHaveLength(1);
		expect(screen.getAllByRole('button', { name: /Have us fix this domain/ })).toHaveLength(1);
		expect(document.body.textContent).not.toMatch(/limited|hurry|only \d+ left|don't miss/i);
	});

	it('comes right after the first step and before the second, so "Do this next" still leads and the offer is on the first screen', async () => {
		// No SPF and no DMARC record: two steps.
		const two = { ...onboarding, dmarc: { ...onboarding.dmarc, found: false, has_our_rua: false, current_record: null, effective: { policy: null, inherited_from: null, issue: null, record: null } }, spf: { record: null, lookup_count: null, flattening_active: false } };
		page({ routes: hostedRoutes({ 'GET /api/domains/1/onboarding-status': two, 'GET /api/domains/1/dns-check': { found: false, has_rua: false, current_record: null, cf_managed: true } }) });
		const button = await offerButton();
		const steps = screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-status'));
		expect(steps.length).toBeGreaterThanOrEqual(2);
		const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
		expect(screen.getByRole('heading', { name: 'Do this next' }).compareDocumentPosition(steps[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(before(steps[0]!, button)).toBe(true);
		expect(before(button, steps[1]!)).toBe(true);
		// The numbering carries on across the offer.
		expect(steps[0]!.textContent).toMatch(/^1/);
		expect(steps[1]!.textContent).toMatch(/^2/);
	});

	it('the price follows the API, not the code', async () => {
		page({ routes: hostedRoutes({ 'GET /api/billing/domains/1': domainBilling({ offer: { ...OFFER, amount: 19950 } }) }) });
		expect(await screen.findByRole('button', { name: 'Have us fix this domain: $199.50 USD' })).toBeInTheDocument();
	});

	it('is absent on a domain that is fine', async () => {
		page({ routes: hostedRoutes(fine) });
		await screen.findByText('Nothing to do');
		expect(screen.queryByRole('button', { name: /Have us fix this domain/ })).not.toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Fix one domain' })).not.toBeInTheDocument();
	});

	it('is absent while billing is off (404), on self-host, and where the price is unusable', async () => {
		const off = page({ routes: { ...base, 'GET /api/billing': fail(404, 'not found') } });
		await screen.findByRole('heading', { name: 'Do this next' });
		await waitFor(() => expect(off.calls.some((c) => c.path === '/api/billing')).toBe(true));
		expect(screen.queryByRole('button', { name: /Have us fix this domain/ })).not.toBeInTheDocument();
		expect(off.calls.some((c) => c.path.startsWith('/api/billing/domains'))).toBe(false);
	});
	it('self-host never asks', async () => {
		const self = page({ status: { mode: 'self-host' }, routes: base });
		await screen.findByRole('heading', { name: 'Do this next' });
		expect(self.calls.some((c) => c.path.startsWith('/api/billing'))).toBe(false);
	});
	it('no offer when the server has no usable price', async () => {
		page({ routes: hostedRoutes({ 'GET /api/billing/domains/1': domainBilling({ offer: null, offer_problem: 'price_misconfigured' }) }) });
		await screen.findByRole('heading', { name: 'Do this next' });
		await waitFor(() => expect(screen.queryByRole('button', { name: /Have us fix this domain/ })).not.toBeInTheDocument());
	});

	it('is replaced by the order while one is open: ordered, started', async () => {
		const paid = order({ status: 'paid', paid_at: 1_800_000_000 });
		page({ routes: hostedRoutes({ 'GET /api/billing/domains/1': domainBilling({ open_order: paid, orders: [paid], can_buy: false }) }) });
		expect(await screen.findByText(`Fix ordered on Jan 15, 2027. ${OFFER.next_steps}`)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Have us fix this domain/ })).not.toBeInTheDocument();
	});
	it('says a started order started, and keeps the offer away', async () => {
		const started = order({ status: 'started', started_at: 1_800_086_400 });
		page({ routes: hostedRoutes({ 'GET /api/billing/domains/1': domainBilling({ open_order: started, orders: [started] }) }) });
		expect(await screen.findByText('Work started on Jan 16, 2027. It ends with our written note that the domain is done.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Have us fix this domain/ })).not.toBeInTheDocument();
	});
	it('a done order is a plain note (and no offer on a domain that is now fine)', async () => {
		const done = order({ status: 'done', done_at: 1_800_172_800 });
		page({ routes: hostedRoutes({ ...fine, 'GET /api/billing/domains/1': domainBilling({ orders: [done] }) }) });
		expect(await screen.findByText('Done on Jan 17, 2027: we sent our written note that the domain is done.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Have us fix this domain/ })).not.toBeInTheDocument();
	});
	it('a refunded order is said, and the offer is available again if there is still something to fix', async () => {
		const refunded = order({ status: 'refunded', refunded_at: 1_800_172_800 });
		page({ routes: hostedRoutes({ 'GET /api/billing/domains/1': domainBilling({ orders: [refunded] }) }) });
		expect(await screen.findByText('The fee for this fix was refunded on Jan 17, 2027.')).toBeInTheDocument();
		expect(await offerButton()).toBeInTheDocument();
	});
	it('a failed payment says so in Stripe\'s words, with the offer to try again', async () => {
		const failed = order({ status: 'failed', failed_at: 1_800_000_000, failure_message: 'Your card was declined.' });
		page({ routes: hostedRoutes({ 'GET /api/billing/domains/1': domainBilling({ orders: [failed] }) }) });
		expect(await screen.findByText(/did not go through: Your card was declined\. You have not been charged\./)).toBeInTheDocument();
		expect(await offerButton()).toBeInTheDocument();
	});
});

describe('the confirm step', () => {
	it('says what is bought, for which domain, the price, the refund rule, what happens next, the links, the card and the email', async () => {
		page({ routes: hostedRoutes() });
		await userEvent.click(await offerButton());
		const d = await dialogOf();
		expect(d.getByRole('heading', { name: 'Fix one domain' })).toBeInTheDocument();
		expect(d.getByText(OFFER.scope)).toBeInTheDocument();
		expect(d.getByText('example.com')).toBeInTheDocument();
		expect(d.queryByRole('textbox')).not.toBeInTheDocument(); // the domain is shown, never typed
		expect(d.getByText('$149 USD')).toBeInTheDocument();
		expect(d.getByText(OFFER.refund_rule)).toBeInTheDocument();
		expect(d.getByText(OFFER.next_steps)).toBeInTheDocument();
		expect(d.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', 'https://readysetmail.com/terms');
		expect(d.getByRole('link', { name: 'Refund policy' })).toHaveAttribute('href', 'https://readysetmail.com/refund-policy');
		expect(d.getByText('Visa ending 4242, expires 12/28')).toBeInTheDocument();
		expect(d.getByText('owner@example.com')).toBeInTheDocument();
		expect(d.getByRole('button', { name: 'Pay $149 USD' })).toBeInTheDocument();
		expect(d.queryByRole('button', { name: 'Add a card to continue' })).not.toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/\b(hours?|within \d|turnaround|business days)\b/i);
	});

	it('has exactly one brand-filled button: Pay', async () => {
		page({ routes: hostedRoutes() });
		await userEvent.click(await offerButton());
		const d = await dialogOf();
		const filled = d.getAllByRole('button').filter((b) => b.className.includes('bg-brand ') || b.className.endsWith('bg-brand') || /\bbg-brand\b/.test(b.className));
		expect(filled.map((b) => b.textContent)).toEqual(['Pay $149 USD']);
	});

	it('without a card the one action is "Add a card to continue": Stripe\'s page, back to this same step', async () => {
		const assign = vi.fn();
		vi.stubGlobal('location', { ...window.location, assign });
		const r = page({ routes: hostedRoutes({ 'GET /api/billing/domains/1': domainBilling({ card: null, card_on_file: false, has_customer: false }), 'POST /api/billing/card-session': { url: 'https://stripe.test/c/pay/cs_1' } }) });
		await userEvent.click(await offerButton());
		const d = await dialogOf();
		expect(d.getByText('No card on file yet.')).toBeInTheDocument();
		expect(d.queryByRole('button', { name: /^Pay/ })).not.toBeInTheDocument();
		await userEvent.click(d.getByRole('button', { name: 'Add a card to continue' }));
		await waitFor(() => expect(assign).toHaveBeenCalledWith('https://stripe.test/c/pay/cs_1'));
		expect(r.calls.find((c) => c.path === '/api/billing/card-session')!.body).toEqual({ return_path: '/domains/1?order=fix-one-domain' });
	});

	it('back from Stripe (?order=fix-one-domain) the same step reopens, with the card, and the address is cleaned', async () => {
		page({ route: '/domains/1?order=fix-one-domain&card=added', routes: hostedRoutes() });
		const d = await dialogOf();
		expect(d.getByRole('button', { name: 'Pay $149 USD' })).toBeInTheDocument();
		expect(d.getByText('Visa ending 4242, expires 12/28')).toBeInTheDocument();
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/domains\/1$/));
	});

	it('Pay sends one request even when clicked twice, with the domain and offer and no price', async () => {
		let release!: (v: unknown) => void;
		const slow = new Promise((r) => (release = r));
		const r = page({ routes: hostedRoutes({ 'POST /api/billing/orders': async () => { await slow; return { order: order(), outcome: 'processing' }; }, 'GET /api/billing/orders/ord_a': { order: order() } }) });
		await userEvent.click(await offerButton());
		const d = await dialogOf();
		const pay = d.getByRole('button', { name: 'Pay $149 USD' });
		await userEvent.dblClick(pay);
		await userEvent.click(pay);
		expect(pay).toBeDisabled();
		release(null);
		await d.findByText('Confirming your payment');
		const posts = r.calls.filter((c) => c.method === 'POST' && c.path === '/api/billing/orders');
		expect(posts).toHaveLength(1);
		expect(posts[0]!.body).toEqual({ domain_id: 1, offer: 'fix-one-domain', expected_amount: 14900, expected_currency: 'usd' });
	});

	it('a payment that needs the bank opens its page in a new tab and waits, then shows it paid', async () => {
		const open = vi.fn();
		vi.stubGlobal('open', open);
		let status = 'pending';
		page({ routes: hostedRoutes({
			'POST /api/billing/orders': { order: order({ action_required: true, action_url: 'https://stripe.test/i/in_1' }), outcome: 'requires_action', action_url: 'https://stripe.test/i/in_1' },
			'GET /api/billing/orders/ord_a': () => ({ order: order(status === 'paid' ? { status: 'paid', paid_at: 1_800_000_000 } : { action_required: true, action_url: 'https://stripe.test/i/in_1' }) }),
		}) });
		await userEvent.click(await offerButton());
		await userEvent.click((await dialogOf()).getByRole('button', { name: 'Pay $149 USD' }));
		const d = await dialogOf();
		expect(await d.findByText("Waiting for your bank's confirmation")).toBeInTheDocument();
		expect(open).toHaveBeenCalledWith('https://stripe.test/i/in_1', '_blank', 'noopener,noreferrer');
		expect(d.getByRole('link', { name: /Open the confirmation page again/ })).toHaveAttribute('target', '_blank');
		status = 'paid';
		expect(await d.findByText('Paid', {}, { timeout: 6000 })).toBeInTheDocument();
		expect(d.getByText(OFFER.next_steps)).toBeInTheDocument();
	}, 15000);

	it('a declined card shows Stripe\'s message in plain words and offers to change the card', async () => {
		page({ routes: hostedRoutes({ 'POST /api/billing/orders': { order: order({ status: 'failed', failure_message: 'Your card was declined.', failed_at: 1_800_000_000 }), outcome: 'failed', message: 'Your card was declined.' } }) });
		await userEvent.click(await offerButton());
		await userEvent.click((await dialogOf()).getByRole('button', { name: 'Pay $149 USD' }));
		const d = await dialogOf();
		expect(await d.findByText(/Your card was declined\. You have not been charged\./)).toBeInTheDocument();
		expect(d.getByRole('button', { name: 'Change card' })).toBeInTheDocument();
		expect(d.queryByRole('button', { name: 'Pay $149 USD' })).not.toBeInTheDocument();
	});

	it('a declined card says "You have not been charged." once', async () => {
		page({ routes: hostedRoutes({ 'POST /api/billing/orders': { order: order({ status: 'failed', failure_message: 'Your card was declined.', failed_at: 1_800_000_000 }), outcome: 'failed', message: 'Your card was declined.' } }) });
		await userEvent.click(await offerButton());
		await userEvent.click((await dialogOf()).getByRole('button', { name: 'Pay $149 USD' }));
		const d = await dialogOf();
		await d.findByText(/Your card was declined\./);
		expect(screen.getByRole('dialog').textContent!.match(/You have not been charged/g)).toHaveLength(1);
		// a server-written failure that already says it
		const again = page({ routes: hostedRoutes({ 'POST /api/billing/orders': { order: order({ status: 'failed', failure_message: 'We could not start the payment. You have not been charged.', failed_at: 1_800_000_000 }), outcome: 'failed', message: 'We could not start the payment. You have not been charged.' } }) });
		void again;
	});

	it('a changed price (409 price_changed) re-renders the step with the new price, and the next Pay confirms that price', async () => {
		const orders: any[] = [];
		const r = page({ routes: hostedRoutes({ 'POST /api/billing/orders': (req: any) => {
			orders.push(req.body);
			return req.body.expected_amount === 14900
				? { __status: 409, body: { error: 'The price changed. Review it and confirm again.', code: 'price_changed', amount: 99900, currency: 'usd' } }
				: { order: order({ amount: 99900 }), outcome: 'processing' };
		}, 'GET /api/billing/orders/ord_a': { order: order({ amount: 99900 }) } }) });
		await userEvent.click(await offerButton());
		let d = await dialogOf();
		await userEvent.click(d.getByRole('button', { name: 'Pay $149 USD' }));
		d = await dialogOf();
		expect(await d.findByText(/The price changed to \$999 USD/)).toBeInTheDocument();
		expect(d.getByText('$999 USD')).toBeInTheDocument(); // the price row
		expect(d.queryByRole('button', { name: 'Pay $149 USD' })).not.toBeInTheDocument();
		await userEvent.click(d.getByRole('button', { name: 'Pay $999 USD' }));
		await d.findByText('Confirming your payment');
		expect(orders).toEqual([
			{ domain_id: 1, offer: 'fix-one-domain', expected_amount: 14900, expected_currency: 'usd' },
			{ domain_id: 1, offer: 'fix-one-domain', expected_amount: 99900, expected_currency: 'usd' },
		]);
		void r;
	});

	it('an order that already exists (409) is shown, not charged again', async () => {
		const { ApiError } = await import('../src/lib/api');
		void ApiError;
		page({ routes: hostedRoutes({ 'POST /api/billing/orders': { __status: 409, body: { error: 'There is already an order for this domain.', code: 'order_open', order: order() } }, 'GET /api/billing/orders/ord_a': { order: order() } }) });
		await userEvent.click(await offerButton());
		await userEvent.click((await dialogOf()).getByRole('button', { name: 'Pay $149 USD' }));
		expect(await (await dialogOf()).findByText('Confirming your payment')).toBeInTheDocument();
	});

	it('a member or admin is told only the owner can buy, and has no pay button', async () => {
		for (const role of ['member', 'admin'] as const) {
			const { unmount } = page({ role, routes: hostedRoutes({ 'GET /api/billing/domains/1': domainBilling({ role, can_buy: false, card: undefined, billing_email: undefined }) }) });
			await userEvent.click(await offerButton());
			const d = await dialogOf();
			expect(d.getByText('Only the workspace owner can add a card or buy.')).toBeInTheDocument();
			expect(d.queryByRole('button', { name: /^Pay/ })).not.toBeInTheDocument();
			expect(d.queryByRole('button', { name: 'Add a card to continue' })).not.toBeInTheDocument();
			expect(d.getByText(OFFER.refund_rule)).toBeInTheDocument();
			// the server tells them only that a card exists: no brand, digits, expiry or email
			expect(d.getByText('A card is on file.')).toBeInTheDocument();
			expect(d.queryByText('Billing email')).not.toBeInTheDocument();
			expect(screen.getByRole('dialog').textContent).not.toMatch(/visa|4242|owner@example\.com/i);
			unmount();
		}
	});
});

describe('terms and refund policy links', () => {
	it('are the ones the server derived from the site origin', async () => {
		page({ routes: hostedRoutes({ 'GET /api/billing/domains/1': domainBilling({ terms_url: 'https://site.example/terms', refund_policy_url: 'https://site.example/refund-policy' }) }) });
		await userEvent.click(await offerButton());
		const d = await dialogOf();
		expect(d.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', 'https://site.example/terms');
		expect(d.getByRole('link', { name: 'Refund policy' })).toHaveAttribute('href', 'https://site.example/refund-policy');
	});
});

describe('Settings -> Billing', () => {
	const settings = (opts: Parameters<typeof renderApp>[1]) => renderApp(<><SettingsPage /><Where /></>, { status: { mode: 'saas' }, ...opts });

	it('shows the card, the billing email, the portal button and past orders', async () => {
		const portal = vi.fn();
		vi.stubGlobal('location', { ...window.location, assign: portal });
		const paid = order({ status: 'paid', paid_at: 1_800_000_000 });
		const r = settings({ routes: { 'GET /api/billing': billing({ orders: [paid, order({ id: 'ord_b', domain: 'other.org', domain_id: null, status: 'failed', failed_at: 1_790_000_000 })] }), 'POST /api/billing/portal-session': { url: 'https://stripe.test/portal/bps_1' } } });
		const section = within(await screen.findByRole('region', { name: 'Billing' }));
		expect(await section.findByText('Visa ending 4242, expires 12/28')).toBeInTheDocument();
		expect(section.getByText('owner@example.com')).toBeInTheDocument();
		expect(section.queryByRole('button', { name: 'Add a card' })).not.toBeInTheDocument();
		const rows = section.getAllByRole('row');
		expect(within(rows[1]!).getByRole('link', { name: 'example.com' })).toHaveAttribute('href', '/domains/1');
		expect(within(rows[1]!).getByText('Fix one domain')).toBeInTheDocument();
		expect(within(rows[1]!).getByText('$149 USD')).toBeInTheDocument();
		expect(within(rows[1]!).getByText('Paid')).toBeInTheDocument();
		expect(within(rows[1]!).getByText('Jan 15, 2027')).toBeInTheDocument();
		expect(within(rows[2]!).getByText('Not paid')).toBeInTheDocument();
		await userEvent.click(section.getByRole('button', { name: 'Change card or see invoices' }));
		await waitFor(() => expect(portal).toHaveBeenCalledWith('https://stripe.test/portal/bps_1'));
		expect(r.calls.some((c) => c.path === '/api/billing/portal-session')).toBe(true);
	});

	it('states what was collected when a credit made it less than the price', async () => {
		const paid = order({ status: 'paid', paid_at: 1_800_000_000, amount_paid: 14000 });
		settings({ routes: { 'GET /api/billing': billing({ orders: [paid] }) } });
		const section = within(await screen.findByRole('region', { name: 'Billing' }));
		expect(await section.findByText('$140 USD')).toBeInTheDocument();
	});

	it('without a card: "Add a card" goes to Stripe and back to Settings', async () => {
		const assign = vi.fn();
		vi.stubGlobal('location', { ...window.location, assign });
		const r = settings({ routes: { 'GET /api/billing': billing({ card: null, card_on_file: false, has_customer: false, billing_email: null }), 'POST /api/billing/card-session': { url: 'https://stripe.test/c/pay/cs_2' } } });
		const section = within(await screen.findByRole('region', { name: 'Billing' }));
		expect(await section.findByText('No card on file.')).toBeInTheDocument();
		await userEvent.click(section.getByRole('button', { name: 'Add a card' }));
		await waitFor(() => expect(assign).toHaveBeenCalledWith('https://stripe.test/c/pay/cs_2'));
		expect(r.calls.find((c) => c.path === '/api/billing/card-session')!.body).toEqual({ return_path: '/settings' });
		expect(section.getByText('No orders yet. When a domain has something to fix, its page offers to do it for you.')).toBeInTheDocument();
	});

	it('admins and members see the card and orders and the plain note, and no buttons', async () => {
		for (const role of ['admin', 'member'] as const) {
			const { unmount } = settings({ role, routes: { 'GET /api/billing': billing({ role, can_manage: false, card: undefined, billing_email: undefined }) } });
			const section = within(await screen.findByRole('region', { name: 'Billing' }));
			expect(await section.findByText('A card is on file.')).toBeInTheDocument();
			expect(section.queryByText('Billing email')).not.toBeInTheDocument();
			expect(screen.getByRole('region', { name: 'Billing' }).textContent).not.toMatch(/visa|4242|owner@example\.com/i);
			expect(section.getByText('Only the workspace owner can add a card or buy.')).toBeInTheDocument();
			expect(section.queryByRole('button')).not.toBeInTheDocument();
			unmount();
		}
	});

	it('is absent when billing is off and on self-host (and asks nothing there)', async () => {
		const off = settings({ routes: { 'GET /api/billing': fail(404, 'not found') } });
		await screen.findByRole('heading', { name: 'Account' });
		await waitFor(() => expect(off.calls.some((c) => c.path === '/api/billing')).toBe(true));
		expect(screen.queryByRole('heading', { name: 'Billing' })).not.toBeInTheDocument();
		off.unmount();
		const self = renderApp(<SettingsPage />, { routes: {} });
		await screen.findByRole('heading', { name: 'Account' });
		expect(self.calls.some((c) => c.path === '/api/billing')).toBe(false);
		expect(screen.queryByRole('heading', { name: 'Billing' })).not.toBeInTheDocument();
	});

	it('handles the return from Stripe: the card parameter is read once and removed', async () => {
		settings({ route: '/settings?card=error', routes: { 'GET /api/billing': billing() } });
		await screen.findByRole('region', { name: 'Billing' });
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/settings$/));
	});
});

describe('the instance owner\'s orders', () => {
	const op = (o: Record<string, unknown> = {}) => ({ ...order({ status: 'paid', paid_at: 1_800_000_000 }), workspace_id: 'ws_a', workspace_name: 'Acme workspace', stripe_invoice_id: 'in_1', next: 'started', ...o });

	it('lists orders across workspaces and moves them: Mark started, then Mark done after a confirmation', async () => {
		let list = [op(), op({ id: 'ord_c', domain: 'zeta.io', workspace_name: 'Zeta', status: 'started', started_at: 1_800_086_400, next: 'done' }), op({ id: 'ord_d', status: 'refunded', refunded_at: 1_800_100_000, next: null })];
		const r = renderApp(<OrdersPage />, { status: { mode: 'saas' }, routes: {
			'GET /api/operator/orders': () => ({ orders: list }),
			'POST /api/operator/orders/ord_a/started': () => { list = [op({ status: 'started', next: 'done' }), ...list.slice(1)]; return { order: list[0] }; },
			'POST /api/operator/orders/ord_c/done': () => ({ order: list[1] }),
		} });
		const rows = await screen.findAllByRole('row');
		expect(within(rows[1]!).getByText('Acme workspace')).toBeInTheDocument();
		expect(within(rows[1]!).getByText('owner@example.com')).toBeInTheDocument();
		expect(within(rows[1]!).getByText('$149 USD')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /refund/i })).not.toBeInTheDocument();
		await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Mark started' }));
		await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Mark started' }));
		await waitFor(() => expect(r.calls.map((c) => c.method + ' ' + c.path)).toContain('POST /api/operator/orders/ord_a/started'));
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
		const zeta = (await screen.findAllByRole('row')).find((row) => within(row).queryByText('zeta.io'))!;
		await userEvent.click(within(zeta).getByRole('button', { name: 'Mark done' }));
		const dlg = within(await screen.findByRole('dialog'));
		expect(dlg.getByText(/after it the buyer can no longer ask for the full fee back/)).toBeInTheDocument();
		await userEvent.click(dlg.getByRole('button', { name: 'Mark done' }));
		await waitFor(() => expect(r.calls.some((c) => c.path === '/api/operator/orders/ord_c/done')).toBe(true));
	});

	it('explains a 403 for everyone but the instance owner, without naming the instance\'s settings', async () => {
		renderApp(<OrdersPage />, { role: 'admin', status: { mode: 'saas' }, routes: { 'GET /api/operator/orders': fail(403, 'operator required') } });
		expect(await screen.findByText('This page is not available to your account')).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/OWNER_EMAIL/);
	});
	it('says so when there are none', async () => {
		renderApp(<OrdersPage />, { status: { mode: 'saas' }, routes: { 'GET /api/operator/orders': { orders: [] } } });
		expect(await screen.findByText('No orders yet')).toBeInTheDocument();
	});
});

describe('the orders list on a narrow screen', () => {
	it('also renders one card per order, with every detail and the action', async () => {
		renderApp(<OrdersPage />, { status: { mode: 'saas' }, routes: { 'GET /api/operator/orders': { orders: [{ ...order({ status: 'paid', paid_at: 1_800_000_000 }), workspace_id: 'ws_a', workspace_name: 'Acme workspace', stripe_invoice_id: 'in_1', next: 'started' }] } } });
		const list = within(await screen.findByRole('list', { name: 'Orders' }));
		for (const t of ['Paid', '$149 USD', 'example.com', 'Acme workspace', 'owner@example.com', 'Jan 15, 2027']) expect(list.getByText(t)).toBeInTheDocument();
		expect(list.getByRole('button', { name: 'Mark started' })).toBeInTheDocument();
		expect(screen.getByText(/whatever their status/)).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/Paid orders from/);
	});
});
