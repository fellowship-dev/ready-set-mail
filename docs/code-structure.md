# Code Structure

Architecture and module responsibilities for Ready Set Mail (repo `fellowship-dev/ready-set-mail`; the Cloudflare Worker script is still named `ready-set-mail-worker` by default).

---

## core

The core layer is the Worker entrypoint plus two cross-cutting pieces: the per-request tenant context and the hosted service's product analytics.

### `src/index.ts` — Worker Entrypoint

Exports the `Env` interface that describes every Cloudflare binding and secret the Worker depends on:

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | `D1Database` | Persistent storage (settings, domains, subscriptions, audit log) |
| `ASSETS` | `Fetcher` | Serves the dashboard SPA for all non-API routes |
| `SEND_EMAIL` | `SendEmail` | CF Email Workers outbound binding for notification emails |
| `AUTH_LIMITER` | Rate limiter | 10 req/min per key — protects auth endpoints |
| `API_LIMITER` | Rate limiter | 200 req/min global — protects all API routes |
| `CLOUDFLARE_API_TOKEN` | secret | EMAIL token — DNS writes and email routing |
| `OAUTH_KV` | `KVNamespace` | Installation-owned agent OAuth state/token storage |
| `BETTER_AUTH_URL` | var | Canonical HTTPS browser/agent issuer origin |
| `BOOTSTRAP_SECRET` | secret | Installer-held single-use first-owner proof |
| `TOKEN_ENCRYPTION_KEY` | secret | Encrypts Cloudflare and Google provider credentials |
| `GOOGLE_POSTMASTER_CLIENT_ID`, `GOOGLE_POSTMASTER_CLIENT_SECRET` | vars / private secret | Separate Google Postmaster read connection |
| `WORKER_NAME` | var | Defaults to `"ready-set-mail-worker"` |
| `MODE` | var (optional) | `selfhost` (default) or `saas` |

Three handlers are exported:

**`fetch(request, env, ctx)`** — HTTP handler

Routing priority (evaluated top to bottom):

1. If `env.DB` is missing → return setup page (503 HTML with wrangler setup instructions)
2. `mta-sts.*` hostname → the MTA-STS policy file at `/.well-known/mta-sts.txt` and a 404 for everything else that reaches the Worker (RFC 8461; `src/mta-sts/serve.ts`; which paths reach it: [docs/mta-sts.md](mta-sts.md#other-paths-on-a-policy-host))
3. MCP/OAuth/discovery and agent-connection routes → installation-owned OAuth adapter with current D1 principal/grant checks
4. `/health` or `/api/*` → `handleApi()` (dashboard API, DNS provisioning)
5. Anything else → `env.ASSETS.fetch(request)` (dashboard SPA)

**`email(message, env, ctx)`** — Email Worker handler

Routes inbound emails (DMARC RUA reports + free one-shot checks) to `handleEmail()`.

**`scheduled(event, env, ctx)`** — Cron dispatcher

Keyed on `event.cron` (the expression string from `wrangler.jsonc`):

| Cron | Time | Task |
|------|------|------|
| `0 11 * * *` | 11am UTC daily | SPF flattening refresh (`runSpfRefresh`, `src/spf/refresh.ts`; [spf-flattening.md](spf-flattening.md)); on the hosted service only: the lifecycle emails of `src/lifecycle/email/` (records live, first-report catch-up, no reports yet; [hosted.md](hosted.md#lifecycle-emails)) and the product analytics' daily step ("No Report After 3 Days"; a no-op unless PostHog is configured, [analytics.md](analytics.md)); then `src/hosted/cron.ts` |
| `0 9 * * 1` | 9am UTC Monday | Weekly digest emails via `sendWeeklyDigests()` (self-host; returns at once on the hosted service). Nothing in `src/lifecycle/email/` depends on it |
| `0 10 * * *` | 10am UTC daily | Older installations only (they kept the trigger): the same SPF refresh as `0 11` |
| `0 4 * * *` | 4am UTC daily | Data lifecycle: retry failed Cloudflare revocations, backfill pre-0022 alignment verdicts (`src/lifecycle/verdict-backfill.ts`), then retention sweeps (own invocation) |
| `0 8 * * *` | 8am UTC daily (default) | Monitor check + SPF lookup count refresh + rollback regression check + MTA-STS refresh (self-host; the hosted service runs it in its 11:00 job) |

All handlers run `assertSchemaReady(env.DB)` (from `@ready-set-mail/db`) before business logic: the Worker no longer changes the schema, it only checks that `npm run migrate` has been run. Schema, migrations and queries live in `packages/db`.

---

### `src/tenancy/` — Tenant context and Cloudflare client

Everything one request (or one cron workspace) needs is built per request and thrown away with it. There is **no module-level per-tenant state** in `src/` (`test/tenancy/guards.test.ts` enforces it), so concurrent requests for different workspaces in one isolate cannot see each other's zones, settings or branding.

| File | Role |
|------|------|
| `mode.ts` | `MODE=selfhost\|saas` from env; defaults to `selfhost` |
| `resolver.ts` | `WorkspaceResolver` seam `(request, env) => {workspaceId, userId?, role?} \| null`. The self-host resolver always returns the implicit workspace (`ws_default`); the auth lane plugs in a session-based one. Also `listCronWorkspaces` (self-host: just the one) |
| `context.ts` | `TenantContext`: `workspaceId`, `mode`, `settings` (base/reports domain, from address, branding, stored zone), `scope` (workspace-scoped queries), `cf()` (the Cloudflare client factory), `zoneFor(domain)` |
| `load.ts` | `loadTenant(env, workspace)` reads the tenant's settings from D1, derives defaults, resolves the base domain's zone once and persists it. Replaces the old `enrichEnv()` cache |
| `cf-client.ts` | `CfClient`: the only code that talks to `api.cloudflare.com` |

**`CfClient`** is bound to one token. `zoneFor(domain)` finds the zone of *that* domain by its registrable name (`a.b.acme.com` → `acme.com`; shortest candidate first, so `co.uk` style suffixes are skipped) and caches answers for the client's lifetime, which is one request. Every DNS write (apply-dmarc, apply-spf, the SPF flattener, MTA-STS, DMARC mode change) targets the zone of the domain it is for. Records under the reports domain (the `_report._dmarc` authorisation record, Email Routing, null-sender records) go to the reports domain's zone. Failures are typed: `CfNetworkError`, `CfAuthError` (401/403), `CfNotFoundError`, `CfApiError`, `CfZoneNotFoundError`, `CfNotConfiguredError`. The token is held in a private field and never appears in errors, JSON, `inspect` output or logs.

**Crons** (`src/cron.ts`) fan out over the workspaces, each in its own `try`, so one workspace's Cloudflare 403 doesn't stop the others.

**Credentials:** self-host uses the `CLOUDFLARE_API_TOKEN` secret, for the default workspace only (other workspaces link their own connection). In `saas` mode no token is used until per-workspace credentials exist (`loadTenant`'s `cfToken` option is the seam); the operator's token is never shared across tenants.

| Env | Purpose |
|-----|---------|
| `MODE` | `selfhost` (default) or `saas` |
| `WORKER_NAME` | Worker script name; defaults to `ready-set-mail-worker` (existing installs) |

---

### `src/connections/` — Cloudflare connections (OAuth + pasted tokens)

One Ready Set Mail workspace holds several Cloudflare connections; each domain is linked to the one that manages its zone. `crypto.ts` seals tokens (AES-GCM, versioned key id), `oauth.ts` is the PKCE protocol and signed state, `service.ts` stores, refreshes, restricts (zone allow-list) and revokes, `routes.ts` is `/api/cloudflare/*` and `PUT /api/domains/:id/connection`, `relay.ts` is the optional self-host redirect relay (inert unless configured). `TenantContext.cfFor(domain)` is how the rest of the Worker gets a client. See [cloudflare-oauth.md](cloudflare-oauth.md).

### `src/billing/` — Hosted billing (Stripe)

Only active with `MODE=saas` + `SAAS_ENABLED=1` and Stripe configured; see [billing.md](billing.md). `config.ts` (settings, pinned API version, test-only base URL), `stripe-client.ts` (plain-fetch `StripeClient`, key private like `CfClient`), `price.ts` (the price by lookup key, cached in D1), `service.ts` (customer, card, Checkout, portal, purchase), `orders.ts` (the one state machine), `sync.ts` (re-read Stripe and move an order), `webhook.ts` (`POST /api/stripe/webhook`), `routes.ts` (`/api/billing/*`, `/api/operator/orders*`; mounted once in `src/api/router.ts`), `reconcile.ts` (daily job), `notify.ts` (audit and the owner's email), `preflight.ts`. The fake Stripe is `e2e/support/fake-stripe.mjs`.

### `src/hosted/` — Hosted (SaaS) intake and records

Only active with `MODE=saas` + `SAAS_ENABLED=1`; see [hosted.md](hosted.md). `intake.ts` routes `rua+<token>@` / `tls-rpt+<token>@` mail to the token's workspace (no default-workspace fallback), `canary.ts` handles the anonymous `check+<token>@`, `records.ts` is the name-guarded writer for `*.h.<zone>`, `zones.ts` tracks the 3,500-record quota and is the shard seam, `pointers.ts` verifies the customer's CNAME/SPF pointers, `service.ts` + `routes.ts` are `/api/domains/:id/hosted`, `cron.ts` is the daily zone diff.

---

### `src/product-analytics/` — Hosted product analytics (PostHog)

Server-side only, off unless the hosted service sets `POSTHOG_KEY` and `POSTHOG_HOST` (never on a self-hosted installation). `events.ts` is the allow-list (every event, its properties and their closed values), `capture.ts` the one sender (`ctx.waitUntil`, timeout, at most one retry, never throws), `identity.ts` the random per-workspace analytics id, and `auth.ts` / `steps.ts` the one-line hooks the routes call. Events, funnels and privacy rules: [analytics.md](analytics.md). It replaced the opt-in self-host telemetry (`src/telemetry.ts`, removed: its endpoint never resolved).

---

## packages/dns-checks

Pure DNS and email-authentication logic (SPF, DKIM, DMARC, MTA-STS, BIMI, MX, provider detection,
`checkDomain()` with a Levels 0–3 grade). No D1, no Cloudflare zone API, no env globals; `fetch` is
injectable. See `packages/dns-checks/README.md`.

The worker imports it by relative path and only adds the Cloudflare/D1 side:

| Worker module | Role |
|---------------|------|
| `src/email/dns-check.ts` | Adapter: binds the package to global `fetch`. `null` = authoritatively absent; a DNS failure **throws** `DnsLookupError` |
| `src/spf/refresh.ts`, `src/spf/target.ts` | SPF flattening: turn on, refresh, turn off, roll back, the daily job, over `flattenFromSource` in `packages/dns-checks/src/spf-flatten.ts`; where the record lives (the customer's zone or the hosted zone) |
| `src/email/mta-sts.ts` | `discoverMxHosts` / `detectExistingMtaStsMode` (throw on DNS error) + the customer's three records (`createPolicyHostCname`, `createTlsRptRecord`, `createPolicyIdRecord`, `deprovisionMtaSts`) |
| `src/mta-sts/` | MTA-STS (ADR 0021): `service.ts` (availability, enable with rollback, verify, modes, disable), `policy-host.ts` (the policy host seam and the operator zone's own write policy), `evidence.ts` (enforce readiness, disable rule), `refresh.ts` (the one daily job and the operator reconcile), `routes.ts`, `serve.ts` (the policy file; 404 for everything else on `mta-sts.*`), `config.ts` |
| `src/monitor/check.ts` | Diffs baselines; a failed lookup keeps the old baseline and reports no change |

Public Suffix List data comes from the `tldts` dependency; update it with `npm update tldts`.

## Agent and reporting modules

`src/access/` owns finite principals/grants, exact resource resolution and owner administration. `src/mcp/` and `src/auth/mcp-issuer.ts` adapt installation-owned OAuth and tools to that policy. `src/reports/service.ts` combines fresh DNS, captured DMARC/TLS evidence, Google cache and shared remediation for HTTP, dashboard and MCP. `src/metrics/` owns the separate Google Postmaster owner connection and explicit sync. `plugins/ready-set-mail/` contains public client guidance; `tools/configure-agent-plugin.mjs` creates an endpoint-specific copy without credentials. See [operator setup and acceptance](agent-operations.md).
