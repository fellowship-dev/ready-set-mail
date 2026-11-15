import { describe, expect, it } from 'vitest';
import { cardLine, formatMoney, hasSomethingToFix, orderSentence, STATUS_WORDS, type Order } from '../src/lib/billing';

const order = (over: Partial<Order> = {}): Order => ({
	id: 'ord_1', domain: 'acme.com', domain_id: 1, offer: 'fix-one-domain', amount: 14900, currency: 'usd', status: 'paid', amount_refunded: 0, buyer_email: 'o@x.co',
	failure_message: null, action_required: false, action_url: null, created_at: 1_800_000_000, paid_at: 1_800_000_000, started_at: null, done_at: null, refunded_at: null, failed_at: null, ...over,
});
const NEXT = 'We will write to you about the access the work needs. The work starts when you have given it, and ends with our written note that the domain is done.';

describe('money and card words', () => {
	it('whole amounts have no cents, others two; the currency comes from the price', () => {
		expect(formatMoney(14900, 'usd')).toBe('$149');
		expect(formatMoney(14950, 'usd')).toBe('$149.50');
		expect(formatMoney(9900, 'USD')).toBe('$99');
	});
	it('the card line is brand, last four and expiry', () => {
		expect(cardLine({ brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 })).toBe('Visa ending 4242, expires 12/28');
		expect(cardLine({ brand: 'amex', last4: '0005', exp_month: 3, exp_year: 2031 })).toBe('American Express ending 0005, expires 03/31');
		expect(cardLine({ brand: 'newbrand', last4: '1111', exp_month: 1, exp_year: 2030 })).toBe('Newbrand ending 1111, expires 01/30');
	});
});

describe('when is the offer shown', () => {
	const a = (key: string, status: string) => ({ key, status }) as never;
	it('only with something to fix, never while reading, never on "Nothing to do"', () => {
		expect(hasSomethingToFix([a('spf-missing', 'attention')], false)).toBe(true);
		expect(hasSomethingToFix([a('dmarc', 'improve')], false)).toBe(true);
		expect(hasSomethingToFix([a('dmarc', 'gathering')], false)).toBe(true);
		expect(hasSomethingToFix([a('spf-missing', 'attention')], true)).toBe(false); // still reading
		expect(hasSomethingToFix([], false)).toBe(false);
		expect(hasSomethingToFix([a('nxdomain', 'attention')], false)).toBe(false); // a name that does not resolve
		expect(hasSomethingToFix([a('done', 'verified'), a('x', 'attention')], false)).toBe(false);
		expect(hasSomethingToFix([a('dkim-unknown', 'unknown'), a('dkim-old', 'note')], false)).toBe(false); // lookups and notes are not things to fix
	});
});

describe('the sentence for an order', () => {
	it('paid: the brief\'s words, with the date', () => {
		expect(orderSentence(order(), NEXT)).toBe(`Fix ordered on Jan 15, 2027. ${NEXT}`);
	});
	it('started, done, refunded, failed, canceled and pending each say what is true', () => {
		expect(orderSentence(order({ status: 'started', started_at: 1_800_086_400 }), NEXT)).toBe('Work started on Jan 16, 2027. It ends with our written note that the domain is done.');
		expect(orderSentence(order({ status: 'done', done_at: 1_800_172_800 }), NEXT)).toBe('Done on Jan 17, 2027: we sent our written note that the domain is done.');
		expect(orderSentence(order({ status: 'refunded', refunded_at: 1_800_172_800 }), NEXT)).toBe('The fee for this fix was refunded on Jan 17, 2027.');
		expect(orderSentence(order({ status: 'failed', failed_at: 1_800_000_000, failure_message: 'Your card was declined.' }), NEXT)).toBe('The payment on Jan 15, 2027 did not go through: Your card was declined. You have not been charged.');
		expect(orderSentence(order({ status: 'canceled', failed_at: 1_800_000_000 }), NEXT)).toMatch(/was not confirmed\. You have not been charged\.$/);
		expect(orderSentence(order({ status: 'pending' }), NEXT)).toBe('Waiting for the payment to be confirmed.');
		expect(orderSentence(order({ status: 'pending', action_required: true }), NEXT)).toBe("Waiting for your bank's confirmation.");
	});
	it('promises no turnaround time in any state', () => {
		const all = (Object.keys(STATUS_WORDS) as Order['status'][]).map((s) => orderSentence(order({ status: s, started_at: 1, done_at: 1, refunded_at: 1, failed_at: 1 }), NEXT)).join(' ');
		expect(all).not.toMatch(/\b(hours?|days?|weeks?|within|business|turnaround|soon|quickly|asap)\b/i);
	});
});
