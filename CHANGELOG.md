# Changelog

All notable changes to Ready Set Mail are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).
How releases are cut and how each pull request adds its line under `[Unreleased]`: [docs/releasing.md](docs/releasing.md).

## [Unreleased]

## [2.0.0] - YYYY-MM-DD

2.0 rebuilds Ready Set Mail (formerly Inbox Angel) around workspaces, a new dashboard, a one-command installer and agent access. <!-- @legacy-name: the product's earlier name -->

### Upgrading from 1.x

**A 1.x installation (v1.2.0 or earlier) cannot be upgraded in place.** The database migration history was squashed into a new baseline, so `npm run migrate` fails against a 1.x database and there is no step that converts one into the other. Install 2.0 next to the old installation and move over:

1. Keep the old Worker running and export its database: `npx wrangler d1 export inbox-angel --remote --output v1-backup.sql` (use your database's name if you changed it). Keep that file: it is the only copy of your 1.x report history. <!-- @legacy-name: the 1.x database name -->
2. Install 2.0 under a new name: `npm run setup -- --name <new name>` (see "Self-hosters: what changes" below).
3. Open the setup link it prints, create the owner account, add your domains again and point each domain's DMARC `rua` at the new instance's report address.
4. When reports arrive at the new instance, remove the old Worker and its database.

What does not carry over: **report history** (it stays in your export, a SQL dump you can load into SQLite), users and invitations, settings, the audit log and alert subscriptions; all start fresh in the new database. Old `ia_…` API keys do not work in 2.0: issue new `ias_…` credentials. The full procedure: [packages/db/UPGRADING.md](packages/db/UPGRADING.md#installs-from-v120-and-earlier-cannot-be-upgraded-in-place).

### Self-hosters: what changes

- **Install with `npm run setup`.** It creates the D1 database and the `OAUTH_KV` namespace, generates the secrets, deploys the Worker and prints a signed setup link that makes you the owner (valid once, for 15 minutes; `npm run setup -- --new-link --name <name>` prints a fresh one). `npm run setup -- --uninstall --name <name>` removes what it created after exporting the database. The Deploy to Cloudflare button is gone. ([#160](https://github.com/fellowship-dev/ready-set-mail/pull/160), [#164](https://github.com/fellowship-dev/ready-set-mail/pull/164))
- **New settings.** `BOOTSTRAP_SECRET` (the private first-owner proof, at least 32 characters), `BETTER_AUTH_URL` (the instance's HTTPS origin), the `OAUTH_KV` namespace (agent sign-in) and `TOKEN_ENCRYPTION_KEY` (to connect Cloudflare from the dashboard). The installer sets all four and keeps copies of the secrets in `~/.config/ready-set-mail/<name>/`. The rate-limit bindings `AUTH_LIMITER`, `API_LIMITER`, `DNS_PREVIEW_LIMITER`, `MCP_LIMITER`, `OAUTH_TOKEN_LIMITER` and `MCP_ANON_LIMITER` come from `wrangler.jsonc`; your own ids live in the git-ignored `wrangler.local.jsonc`. ([#101](https://github.com/fellowship-dev/ready-set-mail/pull/101), [#113](https://github.com/fellowship-dev/ready-set-mail/pull/113), [#130](https://github.com/fellowship-dev/ready-set-mail/pull/130), [#145](https://github.com/fellowship-dev/ready-set-mail/pull/145), [#160](https://github.com/fellowship-dev/ready-set-mail/pull/160))
- **Migrations are explicit.** The Worker no longer changes its own schema: run `npm run migrate` (`npm run deploy` runs it for you) before the new Worker serves traffic. Until the newest migration is recorded the Worker answers 503 and refuses inbound report mail so senders retry. ([#107](https://github.com/fellowship-dev/ready-set-mail/pull/107), [#115](https://github.com/fellowship-dev/ready-set-mail/pull/115))
- **Renamed resources.** Inbox Angel is now Ready Set Mail: the Worker is `ready-set-mail-worker` in `wrangler.jsonc` (the installer names it after `--name`, default `ready-set-mail`) and the D1 database is `ready-set-mail`. Domain ownership TXT proofs and the setup header from before the rename are still accepted. ([#108](https://github.com/fellowship-dev/ready-set-mail/pull/108), [#149](https://github.com/fellowship-dev/ready-set-mail/pull/149)) <!-- @legacy-name: the product's earlier name -->
- **Retired keys.** `ia_…` API keys and the `API_KEY` setting no longer authenticate; issue finite `ias_…` credentials in Settings instead. ([#101](https://github.com/fellowship-dev/ready-set-mail/pull/101), [#130](https://github.com/fellowship-dev/ready-set-mail/pull/130))
- **Cloudflare connections.** Connect Cloudflare from the dashboard with a pasted token, or with OAuth when the instance has an OAuth client configured; tokens are stored encrypted. A server-wide `CLOUDFLARE_API_TOKEN` secret still works for the default workspace. ([#113](https://github.com/fellowship-dev/ready-set-mail/pull/113), [#163](https://github.com/fellowship-dev/ready-set-mail/pull/163))
- **Scheduled jobs.** Five cron triggers: daily DNS re-check and change alerts (08:00 UTC), the Monday digest (09:00), SPF flattening refresh (10:00), the opt-in telemetry heartbeat (11:00) and a new daily data-lifecycle job (04:00) that retries Cloudflare revocations and deletes data past its retention window. ([#118](https://github.com/fellowship-dev/ready-set-mail/pull/118))
- **Domains with an invalid `sp=`** are now read as receivers apply them (`p=none`, or no DMARC without a valid `rua=`) and say "Fix sp=": to list them on an instance before or after upgrading, see [Domains with an invalid sp=](packages/db/UPGRADING.md#domains-with-an-invalid-sp). ([#170](https://github.com/fellowship-dev/ready-set-mail/pull/170))
- **Update check.** The dashboard and the weekly digest compare your version with the latest published GitHub release and link its notes and the upgrade guide. It is a plain unauthenticated request to GitHub with no instance identifier, cached for hours; `UPDATE_CHECK=off` turns it off. ([#168](https://github.com/fellowship-dev/ready-set-mail/pull/168))

### Added

- **Workspaces and teams.** One login can belong to several workspaces and switch between them. Owners invite people (also people who already have a login) as owner, admin or read-only member, and can transfer ownership, leave or delete a workspace. ([#107](https://github.com/fellowship-dev/ready-set-mail/pull/107), [#109](https://github.com/fellowship-dev/ready-set-mail/pull/109), [#115](https://github.com/fellowship-dev/ready-set-mail/pull/115), [#116](https://github.com/fellowship-dev/ready-set-mail/pull/116))
- **Accounts.** Email and password sign-in, plus GitHub or Google sign-in when their client ids are set. ([#109](https://github.com/fellowship-dev/ready-set-mail/pull/109))
- **Cloudflare-first onboarding.** After creating the owner you connect Cloudflare (a "Create the token in Cloudflare" link opens a pre-filled token form), pick zones and add domains; every DNS change is shown before it is written, a write Cloudflare did not confirm says "Written, not checked", and "I'll add DNS records myself" keeps the copy-and-paste path. When Email Routing rules cannot be read, the screen says why. ([#16](https://github.com/fellowship-dev/ready-set-mail/pull/16), [#163](https://github.com/fellowship-dev/ready-set-mail/pull/163), [#167](https://github.com/fellowship-dev/ready-set-mail/pull/167))
- **A new dashboard.** The overview answers "Am I done?": one row per domain with its level, what public DNS shows, when it was checked and one next step. Light and dark themes; works on phones. ([#112](https://github.com/fellowship-dev/ready-set-mail/pull/112), [#127](https://github.com/fellowship-dev/ready-set-mail/pull/127), [#141](https://github.com/fellowship-dev/ready-set-mail/pull/141), [#146](https://github.com/fellowship-dev/ready-set-mail/pull/146), [#158](https://github.com/fellowship-dev/ready-set-mail/pull/158))
- **Analytics.** Per domain and per workspace: who sends as you, the pass-rate trend, what to fix next and whether it is safe to enforce. ([#114](https://github.com/fellowship-dev/ready-set-mail/pull/114))
- **Guided setup for each record.** SPF provider picker, DKIM selector check, DMARC enforcement wizard, SPF flattening and MTA-STS wizards, and the DMARC report-authorization record created for you. ([#21](https://github.com/fellowship-dev/ready-set-mail/pull/21), [#22](https://github.com/fellowship-dev/ready-set-mail/pull/22), [#23](https://github.com/fellowship-dev/ready-set-mail/pull/23), [#26](https://github.com/fellowship-dev/ready-set-mail/pull/26), [#33](https://github.com/fellowship-dev/ready-set-mail/pull/33), [#61](https://github.com/fellowship-dev/ready-set-mail/pull/61))
- **More ways to add domains.** Subdomains show what they inherit from their parent's DMARC; you can bulk-import a list of domains, discover subdomains from Certificate Transparency logs and pick zones from your Cloudflare account. ([#45](https://github.com/fellowship-dev/ready-set-mail/pull/45), [#48](https://github.com/fellowship-dev/ready-set-mail/pull/48), [#60](https://github.com/fellowship-dev/ready-set-mail/pull/60))
- **Reports and email.** A PDF summary to share, HTML emails (weekly digest, free-check report, DNS change alerts) and an email when the first DMARC report arrives. ([#21](https://github.com/fellowship-dev/ready-set-mail/pull/21), [#44](https://github.com/fellowship-dev/ready-set-mail/pull/44), [#46](https://github.com/fellowship-dev/ready-set-mail/pull/46))
- **One fix engine.** Every finding has a stable id and an exact proposed fix, and is confirmed only when several public DNS resolvers agree. Reports come as HTML, JSON or a Markdown plan you can hand to a coding agent. ([#129](https://github.com/fellowship-dev/ready-set-mail/pull/129))
- **Coding agents (MCP).** Each installation has its own `/mcp` endpoint. An agent signs in through your browser and gets only the domains, actions and expiry you consent to; its tools read DNS and reports and propose fixes, never change DNS or send mail. An Agents page lists and revokes connected agents, `/llms.txt` tells agents how to start, and `plugins/ready-set-mail` packages the setup. ([#130](https://github.com/fellowship-dev/ready-set-mail/pull/130), [#144](https://github.com/fellowship-dev/ready-set-mail/pull/144), [#145](https://github.com/fellowship-dev/ready-set-mail/pull/145), [#158](https://github.com/fellowship-dev/ready-set-mail/pull/158))
- **Product credentials.** Owners create one-time `ias_…` credentials for unattended workers, limited to named products, domains and actions, with rotation and revocation. Owners can also connect Google Postmaster as a separate, read-only source. ([#130](https://github.com/fellowship-dev/ready-set-mail/pull/130))
- **Your data.** Published retention windows with a daily cleanup job, export of a domain (CSV) or a whole workspace (JSON), and account deletion; deleting revokes the Cloudflare access it held. ([#118](https://github.com/fellowship-dev/ready-set-mail/pull/118))
- **Hosted mode (`MODE=saas`).** The code that runs the hosted service: self-serve sign-up from the website with verified email and domain ownership proof, a read-only DNS preview before ownership is proven, plan caps, hosted DNS records and one fixed report address with "Connect reports". ([#111](https://github.com/fellowship-dev/ready-set-mail/pull/111), [#114](https://github.com/fellowship-dev/ready-set-mail/pull/114), [#120](https://github.com/fellowship-dev/ready-set-mail/pull/120), [#121](https://github.com/fellowship-dev/ready-set-mail/pull/121), [#142](https://github.com/fellowship-dev/ready-set-mail/pull/142), [#143](https://github.com/fellowship-dev/ready-set-mail/pull/143), [#147](https://github.com/fellowship-dev/ready-set-mail/pull/147), [#148](https://github.com/fellowship-dev/ready-set-mail/pull/148), [#150](https://github.com/fellowship-dev/ready-set-mail/pull/150))
- **Free-check follow-up.** People who run the free check can get change alerts (double opt-in) and an onboarding email sequence, with one-click unsubscribe; self-hosters get the sequence only with `ONBOARDING_SEQUENCE_ENABLED=1`. ([#119](https://github.com/fellowship-dev/ready-set-mail/pull/119), [#125](https://github.com/fellowship-dev/ready-set-mail/pull/125))
- **Shared packages.** `packages/dns-checks`, `packages/db`, `packages/report` and `packages/ui` as npm workspaces, and a domain audit tool in `tools/audit-fleet`. ([#102](https://github.com/fellowship-dev/ready-set-mail/pull/102), [#103](https://github.com/fellowship-dev/ready-set-mail/pull/103), [#104](https://github.com/fellowship-dev/ready-set-mail/pull/104), [#105](https://github.com/fellowship-dev/ready-set-mail/pull/105), [#129](https://github.com/fellowship-dev/ready-set-mail/pull/129))
- **One-command end-to-end tests.** `bash scripts/e2e-devbox.sh` runs the whole Playwright suite against fresh local instances on a Linux machine. ([#164](https://github.com/fellowship-dev/ready-set-mail/pull/164), [#165](https://github.com/fellowship-dev/ready-set-mail/pull/165))
- **Release notes.** This `CHANGELOG.md`, `scripts/release-notes.mjs` and [docs/releasing.md](docs/releasing.md). ([#168](https://github.com/fellowship-dev/ready-set-mail/pull/168))

### Changed

- **DMARC enforcement steps follow RFC 9989.** The rollout moves `none` → `quarantine; t=y` → `quarantine` → `reject; t=y` → `reject` with explicit `p=` and `sp=`, and a step never weakens a stricter policy already published. ([#47](https://github.com/fellowship-dev/ready-set-mail/pull/47), [#106](https://github.com/fellowship-dev/ready-set-mail/pull/106))
- **DNS results say what is known.** A failed lookup is never shown as "no record", the organizational domain comes from the Public Suffix List, subdomains show the policy they inherit, and DKIM handles unknown tags, revoked keys and wildcard answers. ([#102](https://github.com/fellowship-dev/ready-set-mail/pull/102), [#138](https://github.com/fellowship-dev/ready-set-mail/pull/138), [#140](https://github.com/fellowship-dev/ready-set-mail/pull/140), [#141](https://github.com/fellowship-dev/ready-set-mail/pull/141), [#148](https://github.com/fellowship-dev/ready-set-mail/pull/148), [#158](https://github.com/fellowship-dev/ready-set-mail/pull/158))
- **The dashboard never states what it cannot show.** Missing evidence is shown as missing, not as zero or as a pass. ([#137](https://github.com/fellowship-dev/ready-set-mail/pull/137), [#138](https://github.com/fellowship-dev/ready-set-mail/pull/138), [#139](https://github.com/fellowship-dev/ready-set-mail/pull/139), [#140](https://github.com/fellowship-dev/ready-set-mail/pull/140))
- **Hosted report counting.** On the hosted service a report counts only when its mail authenticated and its sender is a known reporter; others are kept but not counted. Self-hosted installations keep counting every report (`REPORT_COUNTING`). ([#151](https://github.com/fellowship-dev/ready-set-mail/pull/151), [#152](https://github.com/fellowship-dev/ready-set-mail/pull/152), [#153](https://github.com/fellowship-dev/ready-set-mail/pull/153))
- **Hosted sign-up asks for an email first;** you choose your password once, from the verification link. ([#154](https://github.com/fellowship-dev/ready-set-mail/pull/154), [#155](https://github.com/fellowship-dev/ready-set-mail/pull/155), [#156](https://github.com/fellowship-dev/ready-set-mail/pull/156))
- **Removing a domain tells you what happened to its DNS records.** `DELETE /api/domains/:id` now answers `200 {ok, kept}` instead of `204`, listing records it left in place; the audit log records `dns.kept` and `dns.already_gone`. API clients that expected `204` must accept `200`. ([#167](https://github.com/fellowship-dev/ready-set-mail/pull/167))
- **Free-check reports** also reach senders whose own DMARC fails, replies go to `MAIL_REPLY_TO`, and each failing check comes with an exact fix. ([#125](https://github.com/fellowship-dev/ready-set-mail/pull/125))
- **The update check** compares versions properly against the latest published release (it compared with the main branch before, so it could not tell newer from older), names the version available and links the release notes and the upgrade guide. The MCP server reports the product version. ([#168](https://github.com/fellowship-dev/ready-set-mail/pull/168))
- **One DMARC record offer, never weaker than the live policy.** Every page that offers a DMARC record (DNS records, add domain, setup, connect reports, domain settings) offers the same record, keeps the live record's tags and reads `p=Reject`, `p=REJECT` and `p= reject` as `reject`. A record receivers do not apply as written (several records, a TXT that is not DMARC, an invalid `p=` or `sp=`) gets no offer; the page says what is wrong instead. ([#161](https://github.com/fellowship-dev/ready-set-mail/pull/161))
- **One SPF lookup judgement:** 10 DNS lookups are within the limit, 11 fail, on every page and in the fixes. The SPF builder never adds `all` after a `redirect=`, keeps `-all`, and the setup wizard and `POST /api/domains/:id/apply-spf` accept and refuse the same records; the route also refuses a record past the lookup limit. ([#161](https://github.com/fellowship-dev/ready-set-mail/pull/161))
- **An invalid `sp=` or `p=` is said the same way everywhere.** Following RFC 7489 section 6.6.3, receivers treat such a record as `p=none` (or ignore it without a valid `rua=`); the overview, the domain page, the DMARC wizard, the PDF and the agent tools now say so, and the first step is to fix the tag. A domain whose record has an invalid `sp=` was shown at its `p=` (or at `p=none`) before: its level changes at the next DNS refresh. ([#161](https://github.com/fellowship-dev/ready-set-mail/pull/161))
- **What a domain without reports is told.** Where reports cannot be connected (another workspace's reports on a hosted server, no report intake) the next step is "Check each service that sends as <domain>, then move to p=…", one step at a time, on the overview, the domain page, the wizard, the PDF and the agent tools alike. Hosted customers see "Reports for this domain cannot be counted yet. This is on our side; there is nothing for you to do." instead of server configuration text. ([#161](https://github.com/fellowship-dev/ready-set-mail/pull/161))
- **The overview loads with a fixed number of database queries**, whatever the number of domains (it grew with every domain without reports and could pass Cloudflare D1's per-request limit). Single-domain pages read their own summary, which now includes whether reports can be connected. ([#161](https://github.com/fellowship-dev/ready-set-mail/pull/161))

### Removed

- The Deploy to Cloudflare button: use `npm run setup`. ([#160](https://github.com/fellowship-dev/ready-set-mail/pull/160))
- `ia_…` API keys, the `API_KEY` setting and the auto-generated first key; migration `0006` revokes stored keys. ([#101](https://github.com/fellowship-dev/ready-set-mail/pull/101), [#130](https://github.com/fellowship-dev/ready-set-mail/pull/130))
- Schema changes at runtime: the Worker only checks that the newest migration is recorded. ([#107](https://github.com/fellowship-dev/ready-set-mail/pull/107))
- The `BASE_DOMAIN`, `REPORTS_DOMAIN`, `FROM_EMAIL`, `DEBUG`, `TELEMETRY_ENABLED` and `CLOUDFLARE_ACCOUNT_ID` settings: domains are set in the setup wizard and telemetry is an opt-in in Settings. ([#16](https://github.com/fellowship-dev/ready-set-mail/pull/16))
- The old Preact dashboard, replaced by the React dashboard in `web/`. ([#112](https://github.com/fellowship-dev/ready-set-mail/pull/112))

### Fixed

- Changing a domain's DMARC policy now edits only `p=` in the live `_dmarc` record instead of overwriting the report-authorization record. ([#159](https://github.com/fellowship-dev/ready-set-mail/pull/159))
- Setup no longer offers `rua=mailto:undefined`, and the DMARC wizard no longer proposes a weaker policy than the one live in DNS. ([#138](https://github.com/fellowship-dev/ready-set-mail/pull/138), [#140](https://github.com/fellowship-dev/ready-set-mail/pull/140))
- Subdomains covered by their parent's `sp=` or `p=` no longer show as unprotected. ([#141](https://github.com/fellowship-dev/ready-set-mail/pull/141))
- "No reports" is said only when none arrived: reports dropped for storage, not processed or not counted are named on the overview, the domain page, the report list and day pages, the charts, the PDF and in the agent tools. ([#161](https://github.com/fellowship-dev/ready-set-mail/pull/161))
- Subdomain badges, the live policy badge and the Rollout section say only what was read: "DMARC not checked yet", "No DMARC record found" or the record's problem, never `p=none` or "Fully graduated" without evidence. ([#161](https://github.com/fellowship-dev/ready-set-mail/pull/161))
- A failed summary refresh shows the last known steps as possibly out of date, with a retry, instead of "Reading…" forever. ([#161](https://github.com/fellowship-dev/ready-set-mail/pull/161))

### Security

- Creating the first owner requires the installer-held `BOOTSTRAP_SECRET` (or a setup link signed with it): a visitor cannot claim a fresh instance. ([#101](https://github.com/fellowship-dev/ready-set-mail/pull/101), [#130](https://github.com/fellowship-dev/ready-set-mail/pull/130), [#160](https://github.com/fellowship-dev/ready-set-mail/pull/160))
- Cloudflare tokens are encrypted at rest with `TOKEN_ENCRYPTION_KEY`; password-reset and verification links are kept out of logs. ([#113](https://github.com/fellowship-dev/ready-set-mail/pull/113), [#126](https://github.com/fellowship-dev/ready-set-mail/pull/126))
- Report intake checks the sender's mail authentication and caps what it stores per address, workspace and instance. ([#120](https://github.com/fellowship-dev/ready-set-mail/pull/120), [#121](https://github.com/fellowship-dev/ready-set-mail/pull/121), [#151](https://github.com/fellowship-dev/ready-set-mail/pull/151), [#159](https://github.com/fellowship-dev/ready-set-mail/pull/159))
- Rate limits on `/mcp`, `/oauth/*` and per-address sign-in; resending a verification email needs the bot check; changing your password or signing out everywhere ends remembered devices. ([#145](https://github.com/fellowship-dev/ready-set-mail/pull/145), [#155](https://github.com/fellowship-dev/ready-set-mail/pull/155), [#156](https://github.com/fellowship-dev/ready-set-mail/pull/156))
- The installer's secret copies and the uninstall export are readable only by you. ([#160](https://github.com/fellowship-dev/ready-set-mail/pull/160), [#164](https://github.com/fellowship-dev/ready-set-mail/pull/164))
- Hosted accounts need a verified email, and a hosted domain is monitored only after its ownership is proven. ([#120](https://github.com/fellowship-dev/ready-set-mail/pull/120), [#121](https://github.com/fellowship-dev/ready-set-mail/pull/121), [#147](https://github.com/fellowship-dev/ready-set-mail/pull/147))

### Known issues

- Removing a domain leaves its MTA-STS DNS records behind ([issue #166](https://github.com/fellowship-dev/ready-set-mail/issues/166)); delete them in your DNS provider.

## [1.2.0] - 2026-03-10

### Added

- Audit log of every state-changing action, with before and after state, an admin page and `GET /api/audit-log`.
- Security headers on API responses (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security`).
- A per-IP limit of 200 requests a minute (`API_LIMITER` binding, required).
- MTA-STS enforce mode is offered only after at least 7 days in testing with no TLS failures.

### Security

- Report export uses session or API-key authentication; the `?key=` query parameter was removed.

## [0.6.0] - 2026-03-09

### Added

- Deploy to Cloudflare Workers button.
- Email Routing configured on the first domain add.
- Mobile-friendly dashboard.
- Free-check history.
- Update notices in the dashboard and the weekly digest.
- Opt-in anonymous telemetry and a debug logging flag.

[Unreleased]: https://github.com/fellowship-dev/ready-set-mail/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/fellowship-dev/ready-set-mail/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/fellowship-dev/ready-set-mail/releases/tag/v1.2.0
[0.6.0]: https://github.com/fellowship-dev/ready-set-mail/releases/tag/v0.6.0
