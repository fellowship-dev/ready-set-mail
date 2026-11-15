# Billing (hosted service)

In-app purchase of **Fix one domain** on the hosted service (`MODE=saas`). It is the redirect-to-Stripe pattern: nobody types a card number into Ready Set Mail. The owner of a workspace is sent to a Stripe-hosted page to save a card, comes back, and confirms the purchase with one click. One card (one Stripe Customer) per workspace, so an agency can have its client own a workspace and pay for it directly.

Nothing here exists on a self-hosted instance, and nothing on the hosted one until the settings below are present: with billing off there is no offer, no Billing section and no billing route (every one answers `404`).

* [What is sold](#what-is-sold)
* [Configuration](#configuration)
* [Stripe setup](#stripe-setup): price, restricted key, webhook, customer portal
* [The flow](#the-flow)
* [API](#api)
* [Orders](#orders)
* [Operating it](#operating-it)
* [Security and threat model](#security-and-threat-model)
* [Data, export and deletion](#data-and-retention)
* [Testing without Stripe](#testing-without-stripe)
* [Adding a subscription later](#adding-a-subscription-later)

## What is sold

One offer, `fix-one-domain`, "Fix one domain": *The authentication part of Fix it, for one domain: every authorized sender confirmed, SPF and DKIM fixed, DMARC moved to reject.* One time, paid in advance, in USD. The amount is **never in the code**: it is the Stripe price found by lookup key. The seller is Fellowship; the public billing name (Ready Set Mail) is set in Stripe.

* Refund rule, shown at the confirm step: *Until we send the written note that the domain is done, you can ask for the full fee back.*
* After paying: *We will write to you about the access the work needs. The work starts when you have given it, and ends with our written note that the domain is done.* No turnaround time is promised anywhere.
* The confirm step links the website's `/terms` and `/refund-policy` (the origin is the one the sign-up form already uses: `SITE_URL`, or `TERMS_URL`'s origin).

There is no hosted subscription plan and no subscription code.

## Configuration

| Variable | | |
|---|---|---|
| `STRIPE_SECRET_KEY` | secret | a **restricted** key, `rk_live_…` or `rk_test_…`. A full `sk_…` key is refused (preflight: "STRIPE_SECRET_KEY is a full secret key") so a leaked Worker secret cannot read or refund everything |
| `STRIPE_WEBHOOK_SECRET` | secret | the endpoint's signing secret, `whsec_…` |
| `STRIPE_PRICE_LOOKUP_KEY` | optional | default `rsm_fix_one_domain` |
| `STRIPE_API_BASE` | testing only | accepted only as `http://127.0.0.1:<port>` or `http://localhost:<port>` (the local fake); anything else is ignored and `https://api.stripe.com` is used |
| `OWNER_EMAIL` | existing | the instance owner: emailed once per paid order, and the only person who sees the Orders list |
| `SEND_EMAIL` | existing | the binding that carries that email |

Billing is on only when the service is hosted (`MODE=saas`, `SAAS_ENABLED=1`), both Stripe secrets are well formed, and the price resolves. `GET /api/instance/preflight` (instance owner) reports `billing: { state: off | configured | misconfigured, reason?, livemode?, price? }` and an item per problem, by setting name, never a value. Apply migration `0016` first (`npm run migrate`).

Every request is pinned to Stripe API version **`2025-09-30.clover`** (`STRIPE_API_VERSION` in `src/billing/config.ts`; the fake refuses any other). Shapes used: Invoices expose their payments through `expand[]=payments` (the `payment_intent` / `charge` fields of older versions are gone, so charge events are matched by the charge and payment-intent ids stored on the order, falling back to `GET /v1/invoice_payments`); `POST /v1/invoiceitems` takes `price`, `invoice` and `customer`; `POST /v1/invoices/:id/pay` takes `off_session=true`; Checkout `mode=setup` takes `payment_method_types[]=card`. Bump the constant and re-run the tests together.

## Stripe setup

1. **Price.** Create a product "Fix one domain" with one **one-time** price in **USD** with the lookup key `rsm_fix_one_domain` (or your `STRIPE_PRICE_LOOKUP_KEY`). Exactly one active price may carry the key; recurring, non-USD, tiered, zero or duplicate prices are refused (the offer is hidden and the preflight says why). To change the amount, create a new price, move the lookup key to it (Stripe asks to transfer it) and archive the old one; the app reads it within ten minutes (and always freshly when someone pays).
2. **Restricted key.** Developers → API keys → *Create restricted key*. Give exactly these permissions and **None** for everything else (no Subscriptions, Balance, Payouts, Disputes, Files, Radar, Connect, webhook endpoints or API keys). The mapping is by endpoint; the dashboard's resource names may differ slightly, so check against the endpoint column.

   | Permission | Level | Endpoints the Worker calls |
   |---|---|---|
   | Customers | Write | `POST /v1/customers`, `GET /v1/customers/:id`, `POST /v1/customers/:id` (default card) |
   | PaymentMethods | Read | the `invoice_settings.default_payment_method` expansion of `GET /v1/customers/:id` (brand, last 4, expiry) |
   | Checkout Sessions | Write | `POST /v1/checkout/sessions` (mode `setup`), `GET /v1/checkout/sessions/:id` |
   | SetupIntents | Read | the `setup_intent` expansion of the Checkout session |
   | Prices (Products) | Read | `GET /v1/prices?lookup_keys[]=…` |
   | Invoices | Write | `POST /v1/invoices`, `POST /v1/invoices/:id/finalize`, `/pay`, `/void`, `DELETE /v1/invoices/:id` (a draft that never finalized), `GET /v1/invoices/:id`, `GET /v1/invoice_payments` |
   | Invoice Items | Write | `POST /v1/invoiceitems` |
   | PaymentIntents | Read | the `payments.data.payment.payment_intent` expansion of an invoice |
   | Charges | Read | `GET /v1/charges/:id` (refund amounts). **No refund permission**: refunds are made by a person in the dashboard |
   | Customer portal | Write | `POST /v1/billing_portal/sessions` |

3. **Webhook.** Developers → Webhooks → add `https://<your host>/api/stripe/webhook`, endpoint API version `2025-09-30.clover`, and subscribe to exactly: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `charge.refunded`, `customer.deleted`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Any other event type is answered `200` and ignored. (The per-IP API limiter, 200 requests a minute, also applies to Stripe's delivery addresses; that is far above this volume.)
4. **Customer portal.** Settings → Billing → Customer portal: enable *Update payment methods*, *Invoice history* and *Update customer information* (email, billing address); leave cancellation and plan switching off (there are no subscriptions). Add the business name, terms and privacy links under Settings → Public details. The return URL is set per click by the app. Customers use the portal to change the **billing email** and card and to download invoices.
5. **Receipts.** Settings → Emails: *Successful payments* on. The buyer's invoice and receipt come from Stripe to the billing email; Ready Set Mail sends the buyer nothing.

## The flow

1. **Add a card.** The owner clicks *Add a card* (Settings → Billing, or from the confirm step). `POST /api/billing/card-session` creates the workspace's Stripe Customer if it has none (idempotency key `rsm-cust-<workspace id>`, a conditional store `WHERE stripe_customer_id IS NULL`, and a re-read, so two concurrent requests end with one customer; if a key replays a customer that was deleted since, the next key `…-1`, `…-2` makes a fresh one), inserts a binding row (workspace, user, purpose, validated return path), and creates a Checkout session (`mode=setup`, `payment_method_types[]=card`, `customer`, `client_reference_id`, `metadata[workspace_id|purpose|checkout_ref]`). The browser goes to Stripe.
2. **Return.** Stripe redirects to `/api/billing/checkout/return?session_id=…`. The Worker finds the session **in its own table**, requires the signed-in person to be (still) **owner** of that row's workspace, re-fetches the session from Stripe and requires `status=complete`, `mode=setup`, the customer equal to the workspace's customer, matching metadata and client reference, and a succeeded setup intent; then it sets that card as the customer's default and completes the row. The webhook (`checkout.session.completed`) does the same, whichever comes first; the audit entry is written once. The response is `303` to the stored return path (`/#/w/<workspace>/<path>?card=added|canceled|error`). The return can never mark an order paid and can never attach a customer that is not the workspace's. (A browser navigation cannot send `X-Workspace-Id`, so the workspace comes from the stored row and the person's current ownership, not from a header.)
3. **Confirm.** On a domain with something to fix, the offer card opens a confirm step: what is bought, for which domain (shown, never typed), the price from Stripe, the refund rule, what happens next, the terms and refund-policy links, the card that will be charged and the billing email. Without a card the primary button is *Add a card to continue* and the return path is the domain page with `?order=fix-one-domain`, which reopens the same confirm step. With a card it is *Pay $149* (the amount from the price).
4. **Charge.** `POST /api/billing/orders` re-checks owner, hosted, billing on, the domain (live, proven, this workspace), the price (fresh from Stripe) and the card; **inserts the order as `pending` first**; then creates a Stripe **Invoice** (`collection_method=charge_automatically`, `auto_advance=false`, `pending_invoice_items_behavior=exclude`, metadata `order_id|workspace_id|domain|offer`), one invoice item with the price, finalizes it and pays it (`off_session=true`, the default card). Every step carries `Idempotency-Key: rsm-<order id>-<step>`, so a retry or a double click repeats the same objects. The response is `processing`; **only the `invoice.paid` webhook (re-reading the invoice) marks the order paid**.
   * *Why an Invoice and not a bare PaymentIntent:* Stripe emails the buyer a proper invoice and receipt; the customer portal lists it; refunds and credit notes attach to it; and a future subscription invoices the same way (below).
   * Needs the bank (3-D Secure): the answer is `requires_action` with the invoice's `hosted_invoice_url`; the confirm step opens it in a new tab and shows *Waiting for your bank's confirmation* while it polls the order.
   * Declined: the invoice is voided, the order is `failed` with Stripe's own words ("Your card was declined."), and the buyer can change the card and try again (a new order row).
   * A **draft** invoice that never finalized cannot be voided in Stripe, so it is deleted instead.
5. **Notification.** On the one transition to `paid`: an audit entry and an email to `OWNER_EMAIL` (workspace name and id, domain, buyer email, amount, order id, Stripe invoice id). If it cannot be sent, the daily job retries it.
6. **The work.** The instance owner writes to the buyer, then marks the order **started** and, once the written note went out, **done** (Orders list; both audited). Nothing is sent automatically on done.

## API

All JSON, `Cache-Control: no-store`. Everything is `404` when billing is off. Browser **session** only: API keys and agent credentials get `403`. State-changing routes inherit the app's CSRF check for cookie sessions (same-origin `Origin`, or `Sec-Fetch-Site: same-origin`); the webhook is exempt and uses the signature instead.

| Method and path | Who | Notes |
|---|---|---|
| `GET /api/billing` | any role | `{enabled, role, can_manage, billing_email, has_customer, card, offer, offer_problem, orders, terms_url, refund_policy_url}`. The card is read from Stripe now and never stored; `offer` is null (with `offer_problem`) if the price is unusable |
| `GET /api/billing/domains/:id` | any role | `{domain, can_buy, card, billing_email, offer, open_order, orders, …}`; `404` for another workspace's domain |
| `GET /api/billing/orders`, `GET /api/billing/orders/:id` | any role | this workspace's orders; another workspace's id is `404`; a pending order older than an hour is reconciled first |
| `POST /api/billing/card-session` `{return_path?}` | owner | `{url}` to Stripe. `return_path` must be one of the app's own routes (`/settings`, `/domains/<n>`, `/domains/<n>?order=fix-one-domain`), else `/settings` |
| `GET /api/billing/checkout/return?session_id=` | the signed-in owner | `303` as above |
| `POST /api/billing/portal-session` | owner | `{url}` of a new Stripe billing portal session (`409 no_customer` without a customer) |
| `POST /api/billing/orders` `{domain_id, offer: "fix-one-domain", expected_amount?}` | owner | `201 {order, outcome: processing \| requires_action \| failed, action_url?, message?}`; `409 order_open` with the existing order; `409 card_required`, `409 price_changed`, `409 domain_unproven`, `404 domain_not_found`, `502 price_misconfigured`, `429 rate_limited`. Only these three fields are read: a price, amount or currency in the body is ignored |
| `POST /api/stripe/webhook` | Stripe | signature required |
| `GET /api/operator/orders[?status=]` | instance owner | every workspace |
| `POST /api/operator/orders/:id/started`, `…/done` | instance owner | validated, audited; `409 invalid_transition`. There is no refund route |

Non-owners get `403 owner_required` ("Only the workspace owner can add a card or buy.") for every action.

### Webhook handling

Raw body at most 256 KiB; `Stripe-Signature` parsed (`t`, every `v1`); HMAC-SHA256 over `${t}.${rawBody}` with WebCrypto, constant-time verification, 300 s tolerance; `livemode` must match the key; the event id is inserted first into `billing_events` (a repeat does no work; an event that failed, or has been "processing" for over a minute, is run again, so a crash is retried rather than swallowed; a failing handler answers `500` so Stripe retries). The body of an event only says where to look: **every transition re-fetches** the invoice, charge, session or customer from Stripe, and an order event must agree on the order id in the invoice metadata, the Stripe customer, the invoice id (once set) and, for `paid`, the amount and currency, or nothing changes. Logs carry the event id, type and outcome only.

## Orders

```
pending ─▶ paid ─▶ started ─▶ done
   │         └────────┴─────────┴──▶ refunded      (full refund, from paid / started / done)
   ├──▶ failed   (declined, or the invoice was voided after a failed payment)
   └──▶ canceled (never confirmed within an hour, or voided from outside)
```

Moves are validated in one place (`src/billing/orders.ts`) and made by one conditional `UPDATE … WHERE status IN (…)`, so a late or repeated event finds no legal predecessor and changes nothing (`invoice.paid` after `charge.refunded` stays refunded) and exactly one caller performs the side effects. A **partial** refund records `amount_refunded` only. An order is *open* while `pending`, `paid` or `started`; a unique partial index allows one open order per workspace + domain name + offer, so a concurrent second confirm loses the insert and gets `409` with the first order. A pending order that stalled (a crash between Stripe steps, older than a minute) is resumed with the same idempotency keys; one older than an hour is reconciled (re-read from Stripe: paid if the invoice was paid and the webhook got lost, otherwise voided and `canceled`; no invoice, or the invoice is gone: `failed`), on view and in the daily job.

## Operating it

* **Orders** (instance owner, `OWNER_EMAIL` account): the Orders list shows status, workspace, domain, buyer, amount and dates; *Mark started* and *Mark done*.
* **Refunds** are made in the Stripe dashboard (Payments → Refund). The `charge.refunded` webhook moves the order to `refunded` (full) or records the amount (partial). Per the refund rule, refund in full on request until the done note went out.
* **A paid order whose invoice shows paid but the order is `failed`/`canceled`** (only possible if Stripe and our void raced): logged as `[billing] order … is failed but its invoice is paid: refund it in Stripe`.
* **Daily job** (11:00 UTC, with the other hosted jobs): reconcile stale pending orders (25 a day), retry unsent owner emails (20), delete Stripe events older than 90 days, checkout bindings that never reached Stripe, and orders past the accounting period.

## Security and threat model

* **Authority.** Only the workspace **owner** may create a customer, start a card or portal session, or buy; admins and members can only view. Every route derives the workspace from the browser session through the app's resolver, never from an id in the request. An order, session or domain id of another workspace behaves exactly like a missing one (`404`). API keys and agent credentials cannot reach billing at all.
* **CSRF and redirects.** Cookie sessions need a same-origin request for every state change. Return paths are an allow-list of the app's own routes; the server builds the redirect from the workspace id it stored itself, so no request can name a host, scheme or another workspace.
* **Forgery.** The Checkout return is looked up in our table, requires current ownership of that row's workspace, and is verified against Stripe; the webhook is signed and every event is re-fetched and cross-checked. A forged `invoice.paid` for an unpaid invoice changes nothing.
* **Price tampering.** Amount and currency come from the Stripe price (resolved by lookup key, refused unless a single active one-time USD fixed price). The optional `expected_amount` can only cause a refusal.
* **Double charge.** Order row first with a unique open slot; idempotency keys on every Stripe POST; one invoice and one payment per order.
* **Keys.** A restricted key with the permissions above and no refund or delete; held in a private field of `StripeClient`, never in errors, JSON, `inspect` output or logs (the tests pin this). No card number, brand or last four is stored or logged: the card is read from Stripe when someone looks.
* **What an attacker with a stolen owner session can spend.** At most one open Fix order per domain, so at most the domain cap (10 domains on the hosted plan) × the price: **$1,490 at $149**; purchase attempts are rate-limited to 5 per workspace and per user per 10 minutes (D1-backed counters, `billing:order:*`), card and portal sessions to 10. Stripe emails a receipt to the billing email, the operator is emailed for every order, and the operator refunds in full until the done note. The session cannot change the billing email or the card number outside Stripe's own pages, and cannot refund.
* **Known limits.** The server cannot judge whether a domain is already fine (that needs live DNS and reports, which the dashboard evaluates), so the dashboard hides the offer on such domains but a direct API call can still buy; refundable until done. A Stripe idempotency key lives 24 hours, which is why the customer key re-checks for a deleted customer. This code was written without access to Stripe: the API version and parameter shapes are those documented for `2025-09-30.clover` and exercised against the in-repo fake, and a test-mode dry run with a real key is the first thing to do on deploy.

## Data and retention

* **Order rows are accounting records** and have no foreign key to workspaces or domains. Deleting a workspace or a domain keeps them: the workspace id and a name snapshot, the domain name, the buyer's email, the amounts and the Stripe ids all stay. They are kept for **seven years** from creation (the accounting period assumed for Fellowship; change `ORDER_RETENTION_YEARS` in `src/billing/reconcile.ts` if counsel says otherwise) and then deleted by the daily job. The buyer's email is part of that record and is not erased earlier on request while the record must be kept. The checkout bindings are deleted with the workspace.
* **The Stripe Customer is never deleted by us.** It stays in Stripe under Stripe's own terms; deleting a customer in Stripe sends `customer.deleted`, which clears the workspace's customer id and keeps the orders.
* **Export.** `GET /api/workspaces/:id/export` includes the workspace's `billing_orders` (without the hosted invoice URL) and `stripe_customer_id`.
* **Stripe events** are kept 90 days (an idempotency ledger; no payload is stored).
* Nothing is sent to analytics.

## Testing without Stripe

`e2e/support/fake-stripe.mjs` is a small in-memory Stripe: customers, Checkout sessions (with a hosted page that completes and redirects to `success_url`), setup intents, payment methods, invoices, invoice items, finalize / pay / void / delete (cards that succeed, decline, or need authentication), payment intents, charges and refunds, billing portal sessions, prices by lookup key, Idempotency-Key replay (same key and parameters returns the same object, different parameters `400`), version pinning, form encoding, and signed webhook delivery. Use it in-process (`fake.fetch` as `fetch`) or as a local HTTP server (`startFakeStripe`, then `STRIPE_API_BASE=http://127.0.0.1:<port>`). The unit and route tests are in `test/billing/`.

## Adding a subscription later

A subscription would be a Stripe Billing subscription on the **same customer**, started from the same confirm pattern (a confirm step naming the plan, the price and the card, a server-side re-check, the order-first pattern with idempotency keys) and managed by the customer in the **same billing portal** (enable subscription cancel/update there). Already in place: `workspaces.stripe_customer_id` (one customer per workspace), the default payment method, `billing_orders` (add `offer` values and a `stripe_subscription_id` column; a subscription's first invoice would be an `invoice.paid` event for an order created `pending` with `offer = 'plan-…'`), the webhook ledger and the re-fetch-everything handlers (add `customer.subscription.updated|deleted` and `invoice.payment_failed` dunning), and the price-by-lookup-key resolver. Not built: plan entitlements, proration, dunning emails; the restricted key would need Subscriptions: Write.
