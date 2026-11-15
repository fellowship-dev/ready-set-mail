# Cloudflare connections: OAuth and pasted tokens

A Ready Set Mail **workspace** (one per business: a Fellowship workspace, a separate Lexgo workspace…) can connect **one or more
Cloudflare accounts**. Each connection is either

* **OAuth**: the user clicks *Connect Cloudflare*, consents at Cloudflare, and Ready Set Mail keeps the access + refresh token; or
* **token**: the user pastes a Cloudflare API token (fallback, and what self-hosters already use).

Each **domain is linked to the connection that manages its zone**; every DNS/Email-Routing call for that domain uses that
connection's token. Cloudflare consent is per Cloudflare *account*, not per zone, so Ready Set Mail keeps its own **allow-list of
zones** it may manage, and every call outside that list is refused, whatever the token could do. On the hosted service the allow-list is
filled for the owner: every active zone the connection can see is added as a verified domain ([First run](#first-run-import-proof-and-accounts));
elsewhere the owner ticks zones.

Contents: [First run](#first-run-import-proof-and-accounts) · [Operator setup](#operator-setup) · [Configuration](#configuration) · [How it works](#how-it-works) · [API](#api) ·
[Self-host and the relay](#self-host-and-the-relay) · [Rotating TOKEN_ENCRYPTION_KEY](#rotating-token_encryption_key)

## Operator setup

Nothing below is done by the code.

### 1. Encryption key (always)

Connections store their tokens encrypted. Without the key nothing can be stored (the API answers `503 encryption_not_configured`).

```sh
openssl rand -base64 32 | sed 's/^/k1:/' | npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

The `k1:` prefix is the key id (see [rotation](#rotating-token_encryption_key)). A lone key without an id is read as `k1`; as soon as
there is more than one key, **every key needs an explicit id** (`k2:…,k1:…`): the id is never taken from the position, and a
secret like `<key>,<key>` is rejected.
**Back this key up**: lose it and every stored connection must be reconnected.

### 2. Register the OAuth client with Cloudflare (Max only: publishing is irreversible)

This is a manual, one-time step and is **not** automated. It creates a public OAuth client at Cloudflare, and publishing it
cannot be undone.

1. Follow Cloudflare's public OAuth client documentation to register a **public client** (no client secret; PKCE `S256`).
2. Redirect URI to register: `https://<your-host>/api/cloudflare/oauth/callback` (hosted: the production origin).
   The self-host relay uses a different one: see [below](#self-host-and-the-relay).
3. Request the scopes Ready Set Mail needs: read zones, edit DNS records, and (for the reports domain) Email Routing.
   Use the exact scope names Cloudflare lists for those permissions.
4. Copy the client id and the three endpoint URLs (authorize, token, revoke) **from Cloudflare's docs**: the code
   hardcodes none of them.

Until this is done OAuth is simply not offered (`oauth.available: false`) and pasted tokens keep working.

## Configuration

Worker vars (`wrangler.jsonc` `vars`) unless marked secret.

| Variable | | |
|----------|-|-|
| `TOKEN_ENCRYPTION_KEY` | **secret** | `kid:base64(32 bytes)[,kid2:base64…]`; the first key seals, all listed keys open; explicit ids required with more than one key |
| `CF_OAUTH_CLIENT_ID` | var | the public client's id |
| `CF_OAUTH_AUTHORIZE_URL` | var | Cloudflare's authorization endpoint (https) |
| `CF_OAUTH_TOKEN_URL` | var | token endpoint (https) |
| `CF_OAUTH_REVOKE_URL` | var | revocation endpoint (https). Without it, disconnecting cannot revoke the grant remotely and says so (`revoked_remote: false`) |
| `CF_OAUTH_SCOPES` | var | scope names, space- or comma-separated |
| `CF_OAUTH_REDIRECT_URI` | var, optional | default `<origin>/api/cloudflare/oauth/callback`; must be https (localhost excepted) |
| `CF_OAUTH_RELAY_URL` | var, optional | self-host: send the OAuth redirect through the relay, e.g. `https://connect.readysetmail.com` |
| `CF_OAUTH_RELAY_SECRET` | **secret**, relay deployment only | signs the relay's state; setting it turns that Worker into the relay |
| `CF_OAUTH_RELAY_CALLBACK_PATH` | var, optional, relay only | only forward to this callback path |
| `CF_OAUTH_RELAY_ALLOWED_HOSTS` | var, optional, relay only | comma-separated hostnames instances may forward to (registered instances); any other host is refused |

OAuth is offered when the client id, authorize URL and token URL are set **and** `TOKEN_ENCRYPTION_KEY` is configured.
The current baseline includes the Cloudflare connection tables; apply all current migrations with `npm run migrate` before serving the Worker. Google Postmaster uses a separate owner grant while sharing the token-encryption key format; see [agent operations](agent-operations.md#google-postmaster-is-a-separate-owner-connection).

### Testing

`CLOUDFLARE_API_BASE_URL` (var, testing only) sends every Cloudflare API call to a local fake instead of `api.cloudflare.com`; the end-to-end suite uses `e2e/support/fake-cloudflare.mjs` this way. It is honoured only when it is exactly `http://127.0.0.1:<port>` or `http://localhost:<port>`; any other value (a remote host, https, a path, credentials) is ignored and the real API is used, so it can never redirect a real token elsewhere. Leave it unset in production.

`DOH_BASE_URL` (var, testing only) does the same for the DNS-over-HTTPS lookups of the onboarding routes: the fake also answers `/dns-query`, so local runs never read public DNS for its made-up zones. Same localhost-only rule. The existing `onboarding-status` route still reads public DNS.

## How it works

* **Storage.** `cloudflare_connections` holds `token_envelope`: `ia1.<key id>.<iv>.<ciphertext>`, AES-256-GCM via WebCrypto,
  of `{access, refresh, expires_at}`. The additional authenticated data is `<workspace id>|<connection id>`, so a ciphertext
  copied to another row does not open. List queries never select the column; the API serializes an explicit whitelist.
  Tokens never reach logs, JSON or error messages (`TokenMaterial` refuses `JSON.stringify` and `util.inspect`).
* **PKCE + state.** `POST …/oauth/start` generates a verifier and a signed `state` (HMAC-SHA256, 10-minute TTL) bound to the
  workspace, the user and a random nonce that is also set as an HttpOnly `ia_cf_oauth` cookie. The verifier is sealed
  *inside* the state, so it never leaves in the clear. The callback requires the cookie, the signature, the TTL and the
  same workspace and user, then redeems the code with the verifier. Anything else is `400`.
* **Refresh.** An expired access token is refreshed before use, once per request (concurrent calls share it); a `401`
  from Cloudflare triggers one forced refresh and one retry. Refresh tokens are single-use, so an isolate that loses the
  race re-reads what the winner stored instead of failing.
* **Key problems are not customer problems.** If a stored envelope cannot be opened (the key was changed or dropped) the API
  answers `503` ("for the server operator to fix") and logs one line; the connection is **not** marked broken and nobody is
  alerted. Restore the key and everything works again.
* **Broken.** If Cloudflare refuses the refresh (or a pasted token is rejected) the connection becomes `broken`. Calls
  through it fail with `409 {code: "cf_connection_broken", connection_id}` without calling Cloudflare. The workspace's owners
  and admins get an email (same `SEND_EMAIL` path as the change alerts) and an audit entry `cf_connection.broken`, once.
  Reconnecting (`oauth/start` with `connection_id`, or `PUT …/token`) makes it `active` again and keeps its zones and links.
* **Zone enforcement.** Every client for a stored connection carries its allow-list and refuses, before any request leaves
  the Worker, everything under `/zones/<id>` that is not allowed (reads too), `zoneFor()` of a zone that is not allowed, and
  `/accounts/<id>` of a Cloudflare account other than the connection's. Error: `403 {code: "cf_zone_not_allowed"}`.
  A new connection has an empty list: it may touch nothing until the owner picks zones. Zone ids must be 32 hex characters;
  dot segments, encoded separators and look-alike ids are refused before sending. A restricted client also cannot *discover*:
  `GET /zones` and name lookups of zones that were not allowed are refused (discovery happens only through the setup path,
  `GET …/zones`), and `/accounts/*` is limited to the accounts of the connection itself and of its allowed zones (none known →
  all `/accounts/*` refused).
* **Nested (delegated) zones.** A child zone (`child.example.com` as its own Cloudflare zone) shadows the parent: a record
  written for a name inside it to the parent zone is ignored by DNS while the API reports success. So a name is never
  written to the parent when it falls inside a child zone that is not on the allow-list; it is refused with
  `403 cf_zone_not_allowed` ("`x.child.example.com` belongs to zone `child.example.com`, which isn't on this Cloudflare
  connection's allow-list"), and linking such a domain fails with the same message. Two mechanisms: (1) when the list is
  saved, the visible child zones of each allowed zone that were left off are recorded as blocked and refused without
  calling Cloudflare; (2) for names below an allowed zone, `zoneFor` probes Cloudflare for each more specific name
  (read-only, `GET /zones?name=`), so a child created after the list was saved is also caught. To manage names in a child
  zone, allow the child zone too: names then route to the child, and the parent's own names to the parent. A deep name under
  the child is refused or routed to the child, never to the parent.
* **Reconnecting** (`oauth/start` with `connection_id`, or `PUT …/token`) must reach the same Cloudflare account: the new grant
  has to see the recorded account and the accounts of the allowed zones, else `409 cf_account_mismatch` (OAuth: redirect with
  `?cf_error=cf_account_mismatch`, and the new grant is revoked). Add a different account as a new connection.
* **State is single use.** The first callback with a valid state spends it (even a refusal); a replay is `400 oauth_state_used`.
* **Routing.** `tenant.cfFor(domain)` finds the domain (or its nearest parent in the workspace), then its connection, then that
  connection's client. A domain without a connection uses the self-host `CLOUDFLARE_API_TOKEN` **in self-host mode only**;
  in `MODE=saas` it gets `400 "… is not linked to a Cloudflare connection"`. Existing call sites (DNS apply, SPF flatten,
  MTA-STS, Email Routing, provisioning, cron) go through it.
* **Disconnect.** OAuth: the refresh and access tokens are revoked at `CF_OAUTH_REVOKE_URL`, then the row is deleted and
  linked domains are unlinked. Pasted tokens cannot be revoked from here; the owner revokes them in Cloudflare's dashboard.

## First run: import, proof and accounts

**Where the OAuth return lands.** `return_to` is the route the person was on when they pressed *Continue to Cloudflare*. Connecting from the
dashboard (the claim card), the first screen or any setup screen goes into the setup wizard (`#/setup/cloudflare`), so the return
continues there; `#/cloudflare/connect?back=/` and `back=/setup…` are redirected into it. Settings keeps returning to Settings, and a
connect started from a domain's own page (`back=/domains/<id>…`) still lists zones, links that domain and returns to it.

**Import (hosted).** Once a connection exists, the wizard calls `POST /api/cloudflare/connections/:id/import`. The server reads the zone list
through the stored connection (a browser can only name zone ids from that list), and adds every **active** zone as a domain of the workspace,
verified through the connection under the [rule below](#how-a-zone-proves-ownership). Importing writes nothing to DNS; it reads public DNS once per
domain, as adding a domain by hand does. The allow-list becomes the zones that were imported (plus those of domains the workspace already has).
A zone that is not active, not a full setup, not delegated to Cloudflare's name servers or not editable by the token is skipped: no domain, no
claim. Pending claims for imported names, or for names inside an allowed zone, are verified in the same request (and when the allow-list is saved with
`PUT …/zones`: `verified_claims` lists them). It adds at most 10 domains per request and answers `more` > 0 when the caller should ask again.

* **Plan.** On the hosted service a workspace holds at most `MAX_DOMAINS_PER_WORKSPACE` domains (default 10; enforced in the domain insert, `src/domains/service.ts`
  `domainCap`). When the zones would not all fit, nothing is imported and the answer carries `needs_selection: { room, cap, zones }`; the dashboard shows
  the list with "Your plan covers N domains. Choose which to add." and calls import again with `{ "zone_ids": [...] }`. More ids than the room
  is refused (`403 plan_limit`). Self-host has no cap and keeps the zone list, domain step and DNS plan.
* **Idempotent.** A domain the workspace already has is left alone; a second grant for the same account adds nothing twice. A domain a person removes is remembered
  (`removed_domains`) and is not imported again; it is offered under Add domain, and asking for it by id adds it back.
* **Suggestions.** `GET /api/cloudflare/suggestions` lists zones of the working connections that are not domains yet (removed ones marked). Zones that appear in Cloudflare
  later are suggested, never added by themselves.

### How a zone proves ownership

A pending claim, or a name typed into Add domain, is verified through Cloudflare (`src/domains/ownership.ts`, `cloudflareProof`) only when **all** of these hold:

1. the name is the zone's name or below it on a label boundary (`notexample.co.uk` is not inside `example.co.uk`), and the zone is not itself a public suffix such as `co.uk` (`isPublicSuffix`, the Public Suffix List the repository already ships through `tldts`);
2. the zone is on the allow-list of an **active** connection of this workspace, and no allowed-off child zone serves the name;
3. Cloudflare says now, through that connection, that the zone is `active`, a `full` setup (not `partial`/CNAME, not `secondary`) and has the same name;
4. the zone belongs to the connection's own Cloudflare account (the account recorded on the connection and, for a grant that covers several accounts, the account recorded for that zone);
5. the token can edit its DNS: an OAuth grant whose scopes include a DNS write scope, or Cloudflare's zone read lists `#dns_records:edit` for the token. If neither can be established there is no Cloudflare proof;
6. the public name servers of the zone are all among the zone's Cloudflare name servers;
7. hosted: no other workspace has verified the name, a parent of it or a child of it.

Anything else falls back to the DNS record (`_readysetmail.<domain>`). The proof is recorded on the domain (`cf_account_id`, `cf_zone_id`, `verified_at`) and in
the audit log as `domain.proof` (`method: cloudflare_zone`, account, zone id and name, connection, time). It stays when the token is revoked or the connection is removed;
the domain is then still verified and watched, and changing its DNS needs a reconnect.

### Several Cloudflare accounts

One grant can cover several Cloudflare accounts, and one account can be reached through several grants. A connection stores one account id only when the token sees exactly one
account; otherwise the account is a property of each allowed zone (`cloudflare_connection_zones.cf_account_id`, with the name Cloudflare returned). Settings lists each
**account** once (`accounts` in `GET /api/cloudflare/connections`): name, domains verified through it, working or needs reconnecting, who connected it and when, and
"2 connections" when more than one grant reaches it. Account names come from `GET /accounts`, which a token with Account Settings Read can call
([API reference](https://developers.cloudflare.com/api/resources/accounts/methods/list/)); the zone list also names each zone's account. Disconnect stays per grant and the dialog names the other accounts of the same sign-in.

## API

All endpoints need a signed-in **owner or admin** (members get `403`, including for reads), act on the caller's workspace
only, and answer `404` for another workspace's ids. JSON in and out; writes need the usual same-origin/CSRF rules.
Errors are `{ "error": "…", "code"?: "…" }`.

### `GET /api/cloudflare/connections`

```json
{
  "connections": [
    { "id": "cfc_9f…", "label": "Lexgo", "auth_type": "oauth", "status": "active", "status_detail": null,
      "cf_account_id": "…", "cf_account_name": "Lexgo SpA", "scopes": ["…"], "created_by": "user_…",
      "created_at": 1790000000, "last_used_at": 1790001234,
      "zones": [{ "id": "…", "name": "lexgo.cl" }] }
  ],
  "oauth": { "available": true, "scopes": ["…"], "via_relay": false },
  "token_paste": true,
  "encryption_configured": true
}
```

* `status`: `active` | `broken` (needs reconnecting; `status_detail` says why) | `revoked`.
* Self-host with `CLOUDFLARE_API_TOKEN` set: a first entry `{ "id": "env", "implicit": true, "auth_type": "token", … }`.
  It can't be edited or deleted (`400`); linking a domain to `"env"` means "no stored connection".
* Use `oauth.available` to show or hide *Connect Cloudflare*, `token_paste` for the paste form.

### Add a pasted token: `POST /api/cloudflare/connections`

`{ "token": "…", "label"?: "Lexgo" }` → `201 { "connection": {…} }`. Validated with Cloudflare's `/user/tokens/verify`
(`400` if rejected), then encrypted. Zones start unallowed.

### `PUT /api/cloudflare/connections/:id/token`

`{ "token": "…" }` → `{ "connection": {…} }`. New token for a broken pasted-token connection.

### `DELETE /api/cloudflare/connections/:id`

→ `{ "ok": true, "revoked_remote": true | false | null, "unlinked_domains": 2 }`. `revoked_remote` is `null` for pasted
tokens, `false` if Cloudflare couldn't be reached (the local row is gone anyway: tell the user to revoke it in Cloudflare).

### `GET /api/cloudflare/connections/:id` → `{ "connection": {…} }`

### `GET /api/cloudflare/connections/:id/zones`

→ `{ "zones": [{ "id", "name", "allowed": false }] }`: every active zone the connection can see.

### `PUT /api/cloudflare/connections/:id/zones`

`{ "zone_ids": ["…"] }` replaces the allow-list → `{ "zones": [{ "id", "name" }] }`. `400` if an id isn't a zone the token
can see. Names come from Cloudflare, not the request. Narrowing the list stops writes for domains already linked to
zones no longer on it (`403 cf_zone_not_allowed`).

### OAuth

**`POST /api/cloudflare/oauth/start`** `{ "label"?, "return_to"?: "/settings/cloudflare", "connection_id"?: "cfc_…" }`
→ `{ "authorize_url": "https://…", "expires_in": 600 }` and a `Set-Cookie: ia_cf_oauth=…` (HttpOnly). Navigate the browser to
`authorize_url` (`window.location = …`). `return_to` must be a path on this origin (anything else is dropped).
`connection_id` reconnects an existing OAuth connection instead of creating one.
`404 oauth_not_configured` when the deployment has no OAuth client; `503 encryption_not_configured` without the key.

**`GET /api/cloudflare/oauth/callback?code=…&state=…`** is where Cloudflare sends the browser. The UI never calls it. It
answers `302` to `return_to` (default `/`) with a query parameter appended:

* `?cf_connection=<id>`: connected; continue to *pick zones*;
* `?cf_error=<code>`: Cloudflare refused (`access_denied`) or the exchange failed (`invalid_grant`…).

If the state itself is invalid (tampered, expired, other user/workspace/browser, already used) there is no redirect: `400
{ "code": "oauth_state_signature" | "oauth_state_expired" | "oauth_state_mismatch" | "oauth_state_used" | … }`, so the UI should offer *Try again*.

### `PUT /api/domains/:id/connection`

`{ "connection_id": "cfc_…" | "env" | null }` → `{ "ok": true, "domain_id", "connection_id" }`. Links the domain to the
connection that manages its zone. The connection must be `active` (`409` otherwise), find a zone for the domain
(`400 cf_zone_not_found`) and have that zone allowed (`400 cf_zone_not_allowed`). `GET /api/domains` rows carry
`cf_connection_id`.

### Errors the UI should handle on any DNS action

| Status | `code` | Meaning |
|--------|--------|---------|
| 409 | `cf_connection_broken` / `cf_connection_revoked` (+ `connection_id`) | show *Reconnect* for that connection |
| 409 | `cf_account_mismatch` / `cf_account_unverified` | a reconnect reached a different Cloudflare account |
| 503 | `token_encryption_unavailable` / `encryption_not_configured` | server key problem: tell the user to contact the operator (not a reconnect case) |
| 403 | `cf_zone_not_allowed` | the zone is not on the connection's allow-list |
| 400 | | the domain is not linked to a connection (saas), or has no zone in it |

### `POST /api/cloudflare/connections/:id/import` · `GET /api/cloudflare/suggestions`

See [First run](#first-run-import-proof-and-accounts). Import takes `{ "zone_ids"?: [...] }` and answers `{ imported, already, skipped, removed, more, accounts, verified_claims, needs_selection? }`.

### Suggested UI flow

1. Settings → Cloudflare: list connections; *Connect Cloudflare* (if `oauth.available`) and *Paste an API token*.
2. After `?cf_connection=<id>` (or a pasted token): hosted: `POST …/import`, then the dashboard. Self-host: `GET …/zones`, let the owner tick zones, `PUT …/zones`.
3. For each domain: `PUT /api/domains/:id/connection`. Domains whose zone is on exactly one connection can be linked in one click.
4. Show `status: "broken"` connections with a *Reconnect* action.

## Self-host and the relay

Self-hosters keep `CLOUDFLARE_API_TOKEN`: it works unchanged as the implicit connection, and they can also add pasted-token
or OAuth connections (needs `TOKEN_ENCRYPTION_KEY`).

A public OAuth client has fixed redirect URIs, but a self-hosted instance lives on any hostname. The optional **relay**
(`connect.readysetmail.com`) is the one registered redirect URI. It holds no tokens and no state:

```
instance ──► relay /relay/start?cb=<instance callback>&state=<instance state>&challenge=<PKCE challenge>
relay    ──► Cloudflare authorize   (redirect_uri = <relay>/relay/callback, state = relay-signed {cb, state, exp})
Cloudflare ─► relay /relay/callback?code&state     → shows "Continue to <host>"
user clicks ─► relay POST /relay/confirm
relay    ──► <cb>?code=…&state=<instance state>      (nothing else is forwarded)
instance  ─► Cloudflare token endpoint: code + PKCE verifier (the verifier never left the instance)
```

* **The confirmation page is mandatory.** The relay does not forward the code when Cloudflare returns the browser to it. It shows
  a page that names the destination host ("Continue to ia.example.com") and forwards only after the user's explicit click
  (`POST /relay/confirm`, bound to the page by an HttpOnly cookie and an HMAC over the nonce, state and code). Without it the
  relay is a token-theft tool: `cb` is chosen by whoever builds the `/relay/start` link, so an attacker could send a victim
  `relay/start?cb=https://evil.example/x&challenge=<attacker's PKCE challenge>`, the victim would consent to "Ready Set Mail" at
  Cloudflare, the code would land on the attacker's host, and the attacker could redeem it with their own verifier and get DNS
  write on the victim's Cloudflare account. **Never deploy the relay without the confirmation page** (this code cannot be
  configured without it), and keep the page's wording about the destination intact.
* **Registered hosts.** Set `CF_OAUTH_RELAY_ALLOWED_HOSTS=host1,host2` on the relay to accept only those instance hosts
  (checked at start, at the page and at the confirm). Recommended whenever the set of instances is known; unset means any
  https host, with the confirmation page as the only protection. **The hosted relay deployment (`connect.readysetmail.com`) must
  set `CF_OAUTH_RELAY_ALLOWED_HOSTS`** (the hosted instance's host, plus any registered self-host instances) in addition to the
  confirmation page.
* The relay verifies its HMAC and 10-minute expiry (`400` if tampered or expired), requires `cb` to be https with no
  credentials (and optionally a fixed path), and refuses plain-http access. It never logs a URL, code or state; responses
  are `no-store` / `no-referrer`, the page is not frameable. It can neither redeem a code nor see a token. A refusal from
  Cloudflare (`error=access_denied`) carries no authorization and is forwarded without the page.
* **Instance config:** `CF_OAUTH_RELAY_URL=https://connect.readysetmail.com` plus the same `CF_OAUTH_CLIENT_ID`, endpoint
  URLs, scopes and `TOKEN_ENCRYPTION_KEY`. `BETTER_AUTH_URL` is used for `cb` when set.
* **Relay deployment:** the same Worker code with `CF_OAUTH_RELAY_SECRET` set (and the client id, authorize URL, scopes).
  When that secret is set `/relay/*` is served before anything else and needs no database. It is not deployed, and the code
  is inert wherever the secret is unset. The relay's own redirect URI (`https://connect…/relay/callback`) is the one
  registered with Cloudflare.

## Rotating TOKEN_ENCRYPTION_KEY

1. Generate `k2`: `openssl rand -base64 32`.
2. Set the secret to `k2:<new>,k1:<old>` (explicit ids on both). New envelopes use `k2`; `k1` still opens the old ones. An envelope on `k1` is
   re-sealed under `k2` the next time its connection is used.
3. When no envelope uses `k1` any more (`SELECT count(*) FROM cloudflare_connections WHERE token_envelope LIKE 'ia1.k1.%'` is 0),
   drop `k1`. An envelope whose key was dropped can't be opened: its connection turns `broken` and has to be reconnected.

Signed OAuth states use the current key: a rotation during the 10-minute window just makes that attempt retry.
