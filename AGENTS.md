# Ready Set Mail: instructions for coding agents

## Read before you build

1. Read `CONTEXT.md` (the words this product uses), `docs/single-sources.md` (what exists once), `docs/adr/` (decisions; `docs/adr/OPEN.md` lists what is not decided) and the saved flows in `.flowchad/flows/`.
2. Extend, never duplicate. If a concept in `docs/single-sources.md` already has a module, call it or change it there. A second implementation is a bug, and `test/agent-memory/single-sources.test.ts` fails on most of them.
3. A change that contradicts an ADR needs a new ADR that supersedes it, in the same pull request. Do not build on an open decision; ask.
4. Before designing or changing a screen, map its flow to the value moment (`.flowchad/flows/<id>.map.md`) and shorten it from the value backwards (ADR 0012).
5. A change to a page on a protected flow needs a fresh walk record in `.flowchad/walks/` (`/flow-walk <id>`, then `/flow-gate <id> --record .flowchad/walks`). CI runs `scripts/check-flows.sh`.
6. When code moves, update these docs in the same change: `test/agent-memory/docs-truth.test.ts` fails when a path or symbol they name is gone.

## Repository

Cloudflare Worker (`src/`), dashboard (`web/`), shared packages (`packages/ui`, `packages/db`, `packages/dns-checks`, `packages/report`). Hosted service and self-host run the same code (`MODE`, see `CONTEXT.md`). Architecture: `docs/code-structure.md`. Design system: `DESIGN.md`. Product: `PRODUCT.md`.

## Commands

- Tests: `npm test -- --run` (Worker and packages), `npm run test:web`, `npm run test:ui`, `npm run typecheck`.
- End-to-end: `bash scripts/e2e-devbox.sh` on Linux or a devbox, not on a workstation.
- Database: schema and migrations in `packages/db` (`packages/db/UPGRADING.md`).

## Rules

- No secrets, customer names or private URLs in this public repository.
- Self-hosters upgrade with `git pull && npm install && npm run deploy`: every schema change is a migration, every breaking change a `CHANGELOG.md` entry (`docs/releasing.md`).
- Helping a person self-host or set up DMARC is a different task: read `docs/coding-agents.md`.
