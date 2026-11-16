# Agents, product credentials and source metrics

The same installation serves its dashboard, HTTP API and MCP endpoint. Self-hosted agents authenticate with that installation; no Fellowship account or central issuer is required. Reports work with live DNS and explicit unavailable-history states before inbound reporting, outbound mail or Google Postmaster is configured.

## Installer setup

Install with `npm run setup` ([self-hosting guide](self-hosting.md)). It gives the installation its own D1 database, `OAUTH_KV` namespace and canonical HTTPS origin (`BETTER_AUTH_URL`, the workers.dev address unless you pass `--url`), generates the private first-owner proof (`BOOTSTRAP_SECRET`) and `TOKEN_ENCRYPTION_KEY` without printing them, backs both up to `~/.config/ready-set-mail/<name>/` (mode 0600), deploys with them, and prints one setup link. Doing it by hand: [manual install](self-hosting.md#manual-install). Never reuse another installation's OAuth namespace, database or credentials.

`BETTER_AUTH_URL` must be the exact public origin: no path, query, fragment or embedded credentials; an explicitly configured HTTPS port is part of it. `PUBLIC_BASE_URL` is accepted as an origin fallback for MCP, but `BETTER_AUTH_URL` keeps browser auth, callbacks and agent issuer aligned. A request sent to a different origin is refused. Preserve the configured Worker-first routes for `/mcp`, `/oauth/*` and OAuth discovery; an SPA fallback must not serve those endpoints.

**The first owner.** The installer prints a setup link that works once and expires in 15 minutes (`npm run setup -- --new-link` prints a new one). It carries `t=<expiry>.<signature>` in the URL fragment, a signature derived from `BOOTSTRAP_SECRET`; the secret itself is never printed. Installations set up by hand enter the secret in the masked **Installer proof** field, which the dashboard sends only in the `X-Ready-Set-Mail-Bootstrap` header alongside the owner account form, never in a JSON body ([manual install](self-hosting.md#manual-install)). As an agent, never ask for the secret or a password in chat, and never put either in a log, a commit or a URL. The configured value must be at least 32 characters; accepted submissions are capped at 512. A proof is consumed by successful owner setup and cannot reopen signup. Email/password setup does not require SMTP, Google or GitHub sign-in. Social sign-in cannot claim first ownership.

Upgrades build, migrate and deploy in that order (`npm run deploy`). Creating a deployment is separate from verifying its browser and MCP behavior.

## First useful report

1. Complete owner setup, then enroll a domain in the browser. A clean self-host can use manual enrollment; the report does not require granting Cloudflare DNS write access. Hosted enrollment returns a durable pending claim until ownership is proved; retrying resumes the claim rather than creating another monitored domain.
2. In **Settings → Agents**, copy this installation's HTTPS `/mcp` endpoint (the **Agents** page in the navigation shows it too, with the steps for each assistant).
3. From the repository, create a new installation-specific plugin directory:

   ```sh
   node tools/configure-agent-plugin.mjs --endpoint https://mail.example.com/mcp --out /tmp/my-ready-set-mail-plugin
   ```

   The generator refuses existing output directories and URLs containing credentials, a query or a fragment. It writes endpoint configuration, never a token. Install that generated directory through the client's supported local-plugin flow, then reload the client/tools. See [plugin setup](../plugins/ready-set-mail/SETUP.md). The source package has no default server connection.
4. Start the client's browser sign-in. Review the requesting client's publisher/name, token-return hostname, exact workspace/product/domain tuples, actions and expiry. A self-registered client's name is not verified; a loopback redirect sends access to a local application. Consent lasts 1–30 days. Newly added domains, products and memberships do not expand an existing finite grant.
5. Confirm callable tools exist, call `whoami`, then `list_domains` and `get_email_report` for the exact permitted domain. The report must contain live DNS findings, observed source evidence or precise unavailable states, and proposed fixes with prerequisites and verification.

Installation, tool reload, browser authorization, a successful identity call and a useful report are separate checkpoints. Never label an installed plugin connected just because its configuration exists. Direct MCP clients may use the same HTTPS endpoint without the plugin. Client-ID metadata documents are supported (Claude, ChatGPT and VS Code use them when they can); dynamic client registration is off by default and needs the operator's explicit `MCP_DCR_ENABLED=1` ([below](#letting-apps-register-themselves)) for clients that need it, such as Cursor.

## Agents page, limits and the setup check

**Agents** in the dashboard navigation explains what an agent can do on this installation, shows the MCP server URL, the steps for each assistant (Claude, ChatGPT, Cursor, VS Code: one list, `web/src/lib/agent-clients.ts`) and a first prompt, and links to the connection list in Settings. It asks the server what this installation supports (`GET /api/agents/status`: `dynamic_registration`, `metadata_documents`) and says which assistants can connect now; where registration is off it tells the instance owner (and only the owner) the one setting that lets the others connect. It shows the setup only when the installation can accept agents (`OAUTH_KV` bound and `BETTER_AUTH_URL` a canonical HTTPS origin); otherwise the instance owner sees what to configure and everyone else sees that agents are not set up yet.

`/mcp` is answered by the OAuth provider before the API router, so it has its own limits (`src/mcp/rate-limit.ts`):

| Limit | Value | Answer when exceeded |
|---|---|---|
| Requests per agent connection | 100 per 60 s (`MCP_LIMITER`, key `mcp:connection:<principal>`) | HTTP 429, `Retry-After: 60` |
| Requests per workspace, all its agents together | 200 per 60 s (`API_LIMITER`, key `mcp:workspace:<id>`) | HTTP 429, `Retry-After: 60` |
| `/oauth/token`, per IP | 600 per 60 s (`OAUTH_TOKEN_LIMITER`, key `oauth-token:<ip>`) | HTTP 429, `Retry-After: 60` |
| `/oauth/register`, per IP | 10 per 60 s (`AUTH_LIMITER`, key `oauth-register:<ip>`, separate from sign-in) | HTTP 429, `Retry-After: 60` |
| `/oauth/register`, whole instance, when registration is on | `MCP_DCR_DAILY_LIMIT` per 24 hours, default 200 (D1 counter `oauth-register:day`, conditional write) | HTTP 429, `Retry-After` the seconds left |
| `/mcp` without an `Authorization` header, per IP | 60 per 60 s (`MCP_ANON_LIMITER`, key `mcp-anon:<ip>`) | HTTP 429, `Retry-After: 60` |
| Live DNS checks per connection (`inspect_domain`, `get_email_report`, `query_email_metrics`, `plan_remediation`, `get_source_status`) | 10 per 60 s (D1 counter, conditional write) | Tool error `rate_limited` with `retryAfterSeconds` |
| Live DNS checks per workspace | 30 per 60 s (D1 counter, conditional write) | Tool error `rate_limited` with `retryAfterSeconds` |

A Workers ratelimit binding has one fixed number, so the per-connection limit has its own binding at half the workspace limit: one agent at full speed leaves room for the others. Authenticated agent requests are never limited per IP address, because assistants share cloud egress addresses. The per-IP budgets are separate, so registrations from an address never block a token refresh from it, and a request that presents a token is never limited per IP: a bad or expired token always gets 401, so the client refreshes. Each live DNS check count is one conditional D1 write that counts only while the window is under its limit, so simultaneous calls cannot pass it: at most 10 per connection and 30 per workspace in a fixed 60-second window that starts with the first check. The workspace is counted first and gets its count back when the connection refuses, so a refused check leaves nothing spent (in the moment between, a parallel check in that workspace can be refused one count early). Expired counter rows are deleted now and then as checks run. Each live DNS check sends about 45–60 DNS-over-HTTPS lookups to each of two resolvers, so roughly 90–120 Worker subrequests per call (more than the Workers Free plan's 50). The consent page and the connection list keep the dashboard's per-IP budget.

**Missing bindings.** On a self-hosted instance a missing ratelimit binding means that limit does not apply. On the hosted service (`MODE=saas`) `/mcp` answers 503 instead of running unlimited when `MCP_LIMITER` or `API_LIMITER` is missing, and the setup check lists every missing binding (`API_LIMITER`, `AUTH_LIMITER`, `MCP_LIMITER`, `OAUTH_TOKEN_LIMITER`, `MCP_ANON_LIMITER`, `DNS_PREVIEW_LIMITER`) as action needed. The entries are in `wrangler.jsonc` and [docs/hosted.md](hosted.md#ratelimit-bindings).

## Letting apps register themselves

Assistants that publish a client ID metadata document (Claude, ChatGPT, VS Code) connect with no setting. Cursor and older assistants register themselves first (`POST /oauth/register`, RFC 7591). That is **off** until the operator sets `MCP_DCR_ENABLED=1` as a Worker variable (a plain `vars` entry, like the other settings; it is not a secret), then deploys. Removing it turns registration off again; apps already approved keep working. Why it is off, and the limits below: [ADR 0018](adr/0018-apps-introduce-themselves-by-document-or-by-vetted-registration.md).

What protects it (`src/mcp/registration.ts`). A registration gets no access: a signed-in person must approve the app on the consent page, which shows it as **Not verified**.

| Setting | Default | Meaning |
|---|---|---|
| `MCP_DCR_ENABLED` | unset (off) | `1` turns registration on. |
| `MCP_DCR_DAILY_LIMIT` | `200` | Registrations accepted per 24 hours, whole instance. Over it: 429 with `Retry-After`. |
| `MCP_DCR_MAX_CLIENTS` | `1000` | Registered apps kept at once. Over it: 503 `temporarily_unavailable` with `Retry-After`. |
| `MCP_DCR_UNUSED_DAYS` | `7` | A registered app that nobody approved is deleted by the 04:00 UTC lifecycle job after this many days, at most 50 a run. An approved app is never deleted by it. |

A registration is refused (400, an RFC 7591 error body) unless it lists one to five redirect addresses, each `https` or `http` on `localhost`, `127.0.0.1` or `[::1]` (any port, no fragment, no user name, no wildcard); gives a plain-text name of at most 80 characters (no `<`, `>`, `&` or web address; none is stored as "Unnamed app"); asks for a public client (`token_endpoint_auth_method` `none`, or left out), the `authorization_code` and `refresh_token` grants and the `code` response. The one private-use address accepted, only as a listed extra, is `cursor://anysphere.cursor-mcp/oauth/callback`. Each registration, refusal and deletion is an audit entry (`agent.client_registered`, `agent.client_registration_refused` with `reason`, `agent.client_expired`) in the instance's own scope (`ws_default`, actor type `system`); no caller address is stored. The setup check shows a note while it is on, with the limits in effect.

After switching it on, check (replace `$ORIGIN`):

```sh
curl -s $ORIGIN/.well-known/oauth-protected-resource       # resource $ORIGIN/mcp, authorization_servers [$ORIGIN]
curl -s $ORIGIN/.well-known/oauth-protected-resource/mcp   # the same document
curl -s $ORIGIN/.well-known/oauth-authorization-server     # has registration_endpoint, code_challenge_methods_supported ["S256"], "none" in token_endpoint_auth_methods_supported
curl -si -X POST $ORIGIN/mcp | head -5                     # 401 with WWW-Authenticate: Bearer ... resource_metadata="$ORIGIN/.well-known/oauth-protected-resource/mcp"
curl -s -X POST $ORIGIN/oauth/register -H 'content-type: application/json' -d '{"client_name":"Check","redirect_uris":["https://example.com/callback"],"token_endpoint_auth_method":"none"}'   # 201 with a client_id
curl -s -X POST $ORIGIN/oauth/register -H 'content-type: application/json' -d '{"client_name":"Check","redirect_uris":["http://example.com/callback"],"token_endpoint_auth_method":"none"}'    # 400 invalid_redirect_uri
```

The check's own registration stays in the list until the sweep deletes it after `MCP_DCR_UNUSED_DAYS` days.

The instance owner (and nobody else) sees a configuration check in **Settings → Instance**, and a banner on every page while a setting needs action. It names missing or inconsistent settings (mode, `BETTER_AUTH_URL`, `OAUTH_KV`, mail sender, Turnstile keys, ratelimit bindings, `BOOKING_URL`, open client registration) and never shows a configured value (`GET /api/instance/preflight`). On a self-hosted instance the owner is the owner of the first workspace, or the account in `OWNER_EMAIL` when set. **On the hosted service the owner is only the verified account whose email is `OWNER_EMAIL`: without `OWNER_EMAIL` nobody can see the setup check.**

## Unattended product workers

Only a browser **owner** can administer product access or Google Postmaster connections; the admin role alone is insufficient. In owner Settings:

1. Create a named workspace product and assign existing authorized domains. One domain may be mapped to several products.
2. Select the exact credential domains, actions and a finite expiry. Name the service principal and credential, then issue it.
3. Save the masked, one-time `ias_…` credential directly into the worker's secret store. Copy it before acknowledging **Credential stored — clear secret**. It cannot be retrieved later; lists expose only prefixes and usage/expiry metadata.
4. Use it as `Authorization: Bearer <credential>` for `/mcp`, or as `X-Api-Key`/bearer on authorized HTTP routes. Credentials are bound to their principal/workspace and explicit grants. They cannot administer users, create stronger credentials or acquire new domains by guessing IDs.

A partial failure after principal creation is shown with its principal ID and current grants. Review it or revoke the partial principal before starting again; blindly repeating the whole sequence creates duplicate identities.

Rotation creates the replacement first. Store and update the worker with it, then acknowledge **Replacement stored — revoke previous and clear** to revoke the old credential. Existing grants and their expiry remain unchanged. If the replacement was lost before storage, revoke that replacement and issue another; do not recover a secret from logs. Owners can revoke individual grants or credentials, or disable the principal. Interactive users revoke their own browser-authorized agents in Settings. D1 denial is checked on the next completed authorization check; provider cleanup may follow asynchronously. Last-use timestamps are informational and do not extend expiry.

## Upgrade from broad prelaunch keys

Back up the database and apply [the additive migrations](../packages/db/UPGRADING.md). Migration `0006_access_grants.sql` revokes the old `api_keys` rows and adds products, principals, grants and hashed credentials. It preserves users, memberships, domains, report history and the old audit/key rows. It does **not** guess narrower authority for a broad key.

Legacy `ia_…` keys and the old `API_KEY` environment value no longer authenticate. `POST /api/keys` is retired (`410`); old dashboard `/keys` bookmarks lead to Settings. Sign in as the existing owner, create products/mappings and finite grants, issue replacement credentials, update each worker's secret store and verify its permitted report and denied sibling access. No data reset or database recreation is part of this upgrade. Do not restore a broad-key bypass to avoid reissuing credentials.

## Google Postmaster is a separate owner connection

Google sign-in (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) and agent OAuth are separate from Google Postmaster access. The operator configures:

| Setting | Meaning |
|---|---|
| `GOOGLE_POSTMASTER_CLIENT_ID` | Google OAuth application's client ID |
| `GOOGLE_POSTMASTER_CLIENT_SECRET` | Private Google OAuth application secret |
| `TOKEN_ENCRYPTION_KEY` | Private `kid:base64(32 random bytes)` encryption key; preserve it for existing encrypted connections |
| `BETTER_AUTH_URL` | This installation's canonical HTTPS origin |

Register the exact callback `https://mail.example.com/api/metrics/google/oauth/callback` on that application's OAuth client and enable the Google Postmaster API access required by the operator's Google project. The requested read-only scope is `https://www.googleapis.com/auth/postmaster.traffic.readonly`. See [token encryption and rotation](cloudflare-oauth.md#rotating-token_encryption_key) for key format and custody; removing a key still needed by either provider's envelopes makes those stored credentials unreadable.

In **Settings → Google Postmaster metrics**, the owner explicitly connects a domain and approves Google's browser consent. The Google account needs Postmaster access to that domain. Then use **Sync** for a bounded 1–90 day window. This implementation performs owner-requested sync; opening a report reads cached evidence and does not silently grant consent, refresh provider data or schedule a new collection job.

The panel exposes configuration, connection status, last attempt, last successful fetch and cache age. Reports preserve the provider's source periods, fetch time, metric definition, filter, population, unit and denominator where available. Original `provider-rate` values are not silently converted to percentages or averaged. Missing/suppressed data is `no_data`, not zero. Permission denial, revoked tokens, rate limits, provider errors and disconnected/unconfigured states remain explicit; previously cached observations can survive a failed fetch and are labeled stale.

Disconnect stops local use of the connection. If the operator also wants to withdraw Google's app authorization, remove it in the Google account; do not assume a local disconnect proved remote revocation. Never put Google access/refresh tokens in a product credential or agent prompt.

## Read the report correctly

DMARC counts describe messages represented in received aggregate reports; TLS-RPT counts describe observed SMTP TLS sessions. Google spam complaints describe Google's eligible Gmail population. SMTP acceptance, bounces and inbox placement are different measurements. Inbox placement remains explicitly `not_measured` when no source measures it.

Product selectors restrict access, not attribution. A domain shared by two products still has **shared-domain coverage**; its aggregate telemetry cannot identify either product's share. Coverage shows report-start dates, original source periods, receipt/fetch ages, missing dates and truncation. Missing dates are gaps in captured evidence, not proof that no mail was sent. Fresh DNS findings remain useful even when every history source is unavailable.

Proposed fixes reuse the shared report model's evidence, prerequisites, unresolved provider-specific placeholders, expected current values and verification steps. Reports and remediation plans do not change DNS, tighten enforcement or send messages. Existing execution routes require separate explicit authorization and fresh preconditions.

## Owner recovery and acceptance boundaries

Save the owner's password and recovery custody during installation. **Forgot password** uses the configured outbound email path; test delivery to the owner's verified destination separately. A first report needs no outbound service, so an installation with none has no email-based self-service recovery. An already authenticated owner can change their own password. Lost machine credentials are replaced through an authenticated owner session; they are never recovered in clear.

The consumed installer proof is not an owner-recovery bypass. If all owner sessions/passwords and outbound recovery are unavailable, stop for verified operator recovery with a protected D1 backup and the actual installation/account identity. This release does not ship an unattended owner-reset command. Do not clear the owner, `bootstrap_consumed`, users or report data to reopen first setup.

Repository fixtures and local HTTPS protocol/browser tests establish their tested policy and wiring only. They do not establish a deployed desktop client's install/reload/consent/tool behavior or a live Google account's access and unsuppressed metrics. Keep deployed client acceptance and an explicitly approved live Google grant/readback pending until their own receipts exist. A provider's withheld metric stays unresolved even when other metrics succeed. Public signup, production deployment, DNS changes and mail sends require their own authorization and acceptance.
