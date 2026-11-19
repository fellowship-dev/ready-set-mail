// The offer's words and price as the lifecycle emails use them. Everything except the two things below comes from src/billing/offer.ts
// (OFFER_NAME, REFUND_RULE): emails read the offer's words only from there.
//
// OFFER_SUMMARY mirrors the website's single source for the same offer (ready-set-mail-website `frontend/fixtures/entry-offer.json`, `summary`, C1,
// ADR 0013), verbatim. It lives here, not beside OFFER_SCOPE in src/billing/offer.ts, only because a change to a file under src/billing/ needs a
// record for the buy-fix-one-domain flow (AGENTS.md rule 5) and that flow's record of the day (PR 178) already holds the one filename a record
// can have on this date: move it next to OFFER_SCOPE in a change that can carry its own record. OFFER_SCOPE itself still promises reject (decision
// O-3, docs/adr/OPEN.md "Fix one domain scope wording") and is not changed or used by any email.
import { billingLookups } from '@ready-set-mail/db';

export const OFFER_SUMMARY = 'We find every service that sends email as your domain, get each one passing SPF and DKIM, switch on DMARC reporting and send you a written done note you can forward. Moving to reject is a separate follow-on.';

/**
 * The offer's price as last cached by the billing code (src/billing/price.ts), whatever its age, and never a Stripe call: an email must not cost
 * one per recipient. Null when nobody has asked Stripe for it yet. For wording only; a purchase asks Stripe afresh.
 */
export async function cachedOfferPrice(db: D1Database, lookupKey: string): Promise<{ amount: number; currency: string } | null> {
  const row = await billingLookups(db).price.get(lookupKey);
  return row ? { amount: row.amount, currency: row.currency } : null;
}
