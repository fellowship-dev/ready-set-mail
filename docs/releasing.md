# Releasing

A release is a version in [CHANGELOG.md](../CHANGELOG.md), a `vX.Y.Z` tag on `main` and a published GitHub release whose
body is that version's changelog section. Installations learn about it only from the published release
([update check](self-hosting.md#update-check)): bumping `package.json` on `main` notifies nobody, so the version can be
bumped in the release pull request, before the tag.

## Versions

- The product version is the root `package.json` `version`. `/health`, `GET /api/version`, the weekly digest, the MCP
  server's `serverInfo` all report it (`src/version.ts`).
- Workspace packages (`packages/*`, `web/`, `tools/*`) and the agent plugin (`plugins/ready-set-mail`) keep their own
  `0.x` versions. They are internal: nothing publishes them or reads them as the product version, so they are not bumped
  with a release.
- Semantic versioning: a change a self-hoster must act on (a new required setting, a migration that cannot run under the
  old Worker, a removed endpoint or credential) is a major version; new features are minor; fixes are patch.

## Labels and the changelog

Every pull request gets the labels that apply and, when people will notice the change, one line under
`## [Unreleased]` in `CHANGELOG.md`, in the section it belongs to (Added, Changed, Removed, Fixed, Security). Write the
line for the person affected: what they can now do or must now do, ending with the pull request link. Dependency bumps
and internal refactors get no line.

| Label | When |
|---|---|
| `breaking` | Someone running the previous release must do something, or something they relied on stops working |
| `migration` | Adds or changes a file in `migrations/` (say in the PR what it does to existing rows) |
| `self-host` | Changes what a self-hoster installs, configures, runs or sees |
| `hosted` | Changes the hosted service (`MODE=saas`) |
| `agents` | Changes MCP, agent credentials, `/llms.txt` or the plugin |
| `security` | Fixes or hardens authentication, authorization, secrets or untrusted input |
| `docs` | Documentation only, or a doc listed in `docs/public.json` changed |

A `breaking` change also adds what to do to the version's "Self-hosters: what changes" block when the release is cut.

## Cutting a release

Run from a checkout of `main`, with `gh` signed in to an account that can push tags. `X.Y.Z` is the version.

1. **Version and changelog on `main`.** In one pull request: set `version` in `package.json` (and the root entries of
   `package-lock.json`), move the `[Unreleased]` lines under `## [X.Y.Z] - YYYY-MM-DD`, add a fresh empty
   `## [Unreleased]`, and update the compare links at the bottom. Merge it.
2. **Main is green.** In a devbox or Linux CI (not a workstation), on the commit you will tag:

   ```sh
   npm ci && npm run typecheck && npm test && npm run test:ui && npm run test:web && npm run build:dashboard
   bash scripts/e2e-devbox.sh
   ```

   and check that `node scripts/release-notes.mjs X.Y.Z` prints the section.
3. **Date the section.** `node scripts/release-notes.mjs X.Y.Z --set-date $(date -u +%F)`, commit `CHANGELOG.md`
   ("Release X.Y.Z") to `main` and push. This changes no code, so step 2 still holds.
4. **Tag.**

   ```sh
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "Ready Set Mail X.Y.Z"
   git push origin vX.Y.Z
   ```

5. **Publish the GitHub release** with the body taken from the changelog:

   ```sh
   node scripts/release-notes.mjs X.Y.Z --strict > /tmp/rsm-notes-X.Y.Z.md
   gh release create vX.Y.Z -R fellowship-dev/ready-set-mail --verify-tag --latest \
     --title "Ready Set Mail X.Y.Z" --notes-file /tmp/rsm-notes-X.Y.Z.md
   ```

   `--strict` refuses an undated section. From this moment installations on an older version see the update notice
   (within the update check's cache window of a few hours).
6. **Website.** Trigger the website's deploy hook (see below) and check that the changelog page shows the release.
7. **Check one installation.** `curl -s https://<instance>/api/version` on an installation of the previous version shows
   `"status":"newer"` and `"latest":"X.Y.Z"` once its cache expires.

## Website

The website (`fellowship-dev/ready-set-mail-website`, Next.js on Vercel) renders the changelog and the public docs from
**this repository at a release tag**, without copying them. Proposed mechanism (built in the website repository):

- At build time the website resolves the tag to render: an environment variable `RSM_RELEASE_TAG` when set, otherwise the
  latest published release (`GET https://api.github.com/repos/fellowship-dev/ready-set-mail/releases/latest`, with a
  token to avoid the anonymous rate limit). Never `main`: the site then always matches released code.
- It fetches [`docs/public.json`](public.json) from that tag
  (`https://raw.githubusercontent.com/fellowship-dev/ready-set-mail/<tag>/docs/public.json`), then each `public` entry's
  `path` from the same tag, renders the Markdown at `/docs/<slug>` (only the named heading's section when `section` is
  set), and fails the build when a listed file is missing. Paths under `internal`, and anything not listed, are never
  fetched or rendered.
- Relative links between published docs become site links; a link to any other file becomes a GitHub link at the same
  tag (`https://github.com/fellowship-dev/ready-set-mail/blob/<tag>/<path>`).
- A Vercel deploy hook rebuilds the site. Until a workflow calls it on `release: published` (a GitHub Actions job in this
  repository with the hook URL as a secret), step 6 calls it by hand: `curl -fsS -X POST "$RSM_WEBSITE_DEPLOY_HOOK"`.

What is public: `docs/public.json` decides. Add a new user-facing doc to `public` and an operator-only one to `internal`
in the pull request that adds it.
