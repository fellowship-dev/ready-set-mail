# Ready Set Mail: instructions for coding agents

## Read before you build

1. Read `CONTEXT.md` (the words this product uses), `docs/single-sources.md` (what exists once), `docs/adr/` (decisions; `docs/adr/OPEN.md` lists what is not decided) and the saved flows in `.flowchad/flows/`.
2. Extend, never duplicate. If a concept in `docs/single-sources.md` already has a module, call it or change it there. A second implementation is a bug, and `test/agent-memory/single-sources.test.ts` fails on a new site of any listed concept (the message says what to extend and which list to update).
3. A change that contradicts an ADR needs a new ADR that supersedes it, in the same pull request. Do not build on an open decision; ask.
4. Before designing or changing a screen, map its flow to the value moment (`.flowchad/flows/<id>.map.md`) and shorten it from the value backwards (ADR 0012).
5. A change to a file on a protected flow (below) needs a new record for that flow in `.flowchad/walks/`, added by the same pull request. CI runs `scripts/check-flows.sh`.
   - The flow changed for the person: walk it on a local copy of the change and commit the gate's record (`/flow-walk <id>`, then `/flow-gate <id> --target <url> --record .flowchad/walks`). It must carry the gate's fields, say PASS (or PASS-WITH-OVERRIDES) and name a commit that HEAD contains, that is not already in the base, and after which no file the flow covers (its `covers:` files, the flow file and its map) has changed: a later change to a covered file, in your branch or in main, asks for a new walk, while a base that moves elsewhere does not. The file is `<date>-<id>.md`, or `<date>-<id>.<tag>.md` with a tag of `[a-z0-9-]+` (never `not-affected`, which keeps its own meaning), so two pull requests that walk the same flow on the same day add different files.
   - It did not (a refactor, a log line, a fix nobody on the flow can see): add `.flowchad/walks/<date>-<id>.not-affected.md` with Flow, Changed (every mapped file you touched), Reason, By and Date. The reviewer accepts or rejects the reason.
   - The check proves a record is new, complete and fresh; it cannot prove a walk took place. Review is the check that it did.
6. When code moves, update these docs in the same change: `test/agent-memory/docs-truth.test.ts` fails when a path or symbol they name is gone, wherever it points.

## Protected flows

A change to any of these files needs a record for that flow (rule 5). The `covers:` list in each `.flowchad/flows/<id>.yml` is the source; this list must match it (`test/agent-memory/flows.test.ts`).

- **signup-to-records-live-cloudflare**: `web/src/app.tsx`, `web/src/pages/auth/*`, `web/src/pages/wizards/SetupWizardPage.tsx`, `web/src/pages/wizards/cloudflare/*`, `web/src/pages/cloudflare/*`, `web/src/pages/domains/OverviewPage.tsx`, `web/src/pages/domains/DomainDetailPage.tsx`, `web/src/pages/setup/*`, `web/src/components/FirstDay.tsx`, `web/src/components/HandoffCard.tsx`, `web/src/lib/first-run.ts`, `web/src/lib/first-day.ts`, `web/src/components/domain/*`, `src/auth/routes.ts`, `src/auth/codes.ts`, `src/auth/profile.ts`, `src/auth/names.ts`, `src/auth/mail.ts`, `src/auth/signup-policy.ts`, `src/auth/bot-protection.ts`, `src/auth/turnstile.ts`, `src/domains/ownership.ts`, `src/domains/service.ts`, `src/api/router.ts`, `src/connections/*`, `src/onboarding/*`, `src/dns/write-policy.ts`, `src/tenancy/cf-client.ts`
- **signup-to-records-live-manual**: `web/src/app.tsx`, `web/src/pages/auth/*`, `web/src/pages/wizards/SetupWizardPage.tsx`, `web/src/pages/wizards/cloudflare/FirstScreen.tsx`, `web/src/pages/setup/*`, `web/src/components/FirstDay.tsx`, `web/src/lib/first-run.ts`, `web/src/lib/first-day.ts`, `web/src/lib/poll.ts`, `web/src/pages/wizards/setup/*`, `web/src/components/wizard/*`, `web/src/components/domain/ClaimCard.tsx`, `web/src/components/domain/ClaimPreview.tsx`, `web/src/components/domain/ProofRecord.tsx`, `src/auth/routes.ts`, `src/auth/codes.ts`, `src/auth/profile.ts`, `src/auth/names.ts`, `src/auth/mail.ts`, `src/auth/signup-policy.ts`, `src/auth/bot-protection.ts`, `src/auth/turnstile.ts`, `src/domains/ownership.ts`, `src/domains/service.ts`, `src/api/router.ts`, `src/domains/claim-preview.ts`
- **buy-fix-one-domain**: `web/src/components/billing/*`, `web/src/pages/domains/DomainDetailPage.tsx`, `web/src/pages/settings/BillingSection.tsx`, `web/src/pages/operator/OrdersPage.tsx`, `web/src/lib/billing.ts`, `web/src/lib/card-return.ts`, `src/billing/*`
- **invited-teammate-joins**: `web/src/pages/members/MembersPage.tsx`, `web/src/pages/auth/InvitePage.tsx`, `web/src/pages/auth/CodeStep.tsx`, `web/src/pages/auth/SignupCode.tsx`, `web/src/pages/setup/HandOffPage.tsx`, `web/src/components/HandoffCard.tsx`, `web/src/lib/handoff.ts`, `web/src/pages/domains/OverviewPage.tsx`, `src/api/router.ts`, `src/auth/routes.ts`, `src/auth/codes.ts`, `src/auth/mail.ts`, `src/team/handoff.ts`
- **spf-flattening**: `web/src/pages/wizards/SpfFlattenPage.tsx`, `web/src/components/domain/DnsTools.tsx`, `web/src/components/domain/SpfCard.tsx`, `web/src/lib/spf-flatten.ts`, `src/spf/*`, `packages/dns-checks/src/spf-flatten.ts`, `src/hosted/plan-limits.ts`, `src/hosted/allow.ts`
- **agent-connects-and-reads-report**: `src/llms-txt.ts`, `web/src/pages/agent/AgentSetupPage.tsx`, `web/src/pages/auth/*`, `src/mcp/*`, `src/access/*`, `src/auth/mcp-issuer.ts`

So a change to the domain page (`web/src/pages/domains/DomainDetailPage.tsx`) needs records for signup-to-records-live-cloudflare and buy-fix-one-domain; a change to `src/api/router.ts` needs them for both sign-up flows and invited-teammate-joins (the SPF routes in it are covered through `src/spf/*`, not by the router).

## Repository

Cloudflare Worker (`src/`), dashboard (`web/`), shared packages (`packages/ui`, `packages/db`, `packages/dns-checks`, `packages/report`). Hosted service and self-host run the same code (`MODE`, see `CONTEXT.md`). Architecture: `docs/code-structure.md`. Design system: `DESIGN.md`. Product: `PRODUCT.md`.

## Commands

- Tests: `npm test -- --run` (Worker and packages, including `test/agent-memory/`), `npm run test:web`, `npm run test:ui`, `npm run typecheck`; the flow check: `bash scripts/check-flows.sh`.
- End-to-end: `bash scripts/e2e-devbox.sh` on Linux or a devbox, not on a workstation.
- Database: schema and migrations in `packages/db` (`packages/db/UPGRADING.md`).

## Rules

- No secrets, customer names or private URLs in this public repository.
- Self-hosters upgrade with `git pull && npm install && npm run deploy`: every schema change is a migration, every breaking change a `CHANGELOG.md` entry (`docs/releasing.md`).
- Helping a person self-host or set up DMARC is a different task: read `docs/coding-agents.md`.
