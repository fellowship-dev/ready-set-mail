# Self-hosting Ready Set Mail

Ready Set Mail runs on your own Cloudflare account: one Worker, one D1 database and one KV namespace. You need a Cloudflare account, Node.js 22.22.2 or newer (24.15.0+ on the 24 line) and git, on macOS or Linux. Windows is not supported directly; WSL works like Linux.

Contents: [Install](#install) · [What the installer does](#what-the-installer-does) · [Permissions](#permissions) · [Scheduled jobs](#scheduled-jobs) · [Upgrade](#upgrade) · [Uninstall](#uninstall) · [Manual install](#manual-install) · [Troubleshooting](#troubleshooting)

## Install

```sh
git clone https://github.com/fellowship-dev/ready-set-mail.git
cd ready-set-mail
npm install
npm run setup
```

`npm install` also installs Wrangler, Cloudflare's command-line tool, into the project; you do not need it installed globally. If you are not logged in to Cloudflare, `npm run setup` opens the Cloudflare login in your browser.

The installer asks at most two things: which Cloudflare account to use (only when your login can see more than one), and whether to go ahead with the plan it shows. It ends with your instance's address and one link:

```
Ready Set Mail is running at https://ready-set-mail.<your-subdomain>.workers.dev. Open this link to create your owner account:

  https://ready-set-mail.<your-subdomain>.workers.dev/#/setup?t=…

The link works once and expires in 15 minutes. Need a new one? npm run setup -- --new-link --name ready-set-mail
If the page asks for an installer proof, paste the contents of ~/.config/ready-set-mail/ready-set-mail/bootstrap-proof.
```

Open the link and create your account. The link is signed with the instance's first-owner secret and is valid until an owner account exists, for at most 15 minutes. If the page asks for an installer proof, paste the contents of `~/.config/ready-set-mail/<name>/bootstrap-proof`. `npm run setup -- --new-link --name <name>` prints a fresh one at any time, without redeploying.

Then add your domain in the dashboard and follow its steps.

### Options

| Flag | Meaning |
|---|---|
| `--name <name>` | Instance name (default `ready-set-mail`). The Worker and D1 database get this name, the KV namespace `<name>-oauth`. Use another name for a second instance in the same account. |
| `--account-id <id>` | The account to install into. Also read from `CLOUDFLARE_ACCOUNT_ID`. |
| `--url <https-origin>` | Serve from your own domain, for example `https://mail.example.com`. It only sets the address: after setup, attach that domain to the Worker yourself (Workers & Pages → the Worker → Settings → Domains & Routes). Until then the installer checks the Worker at its workers.dev address; an account without one gets the database check only. |
| `--yes` | Do not ask for confirmation. |
| `--dry-run` | Check everything and show the plan, then stop. |
| `--resume` | Continue an install that stopped part-way. |
| `--json` | Print one JSON line at the end (human-readable lines go to standard error). |
| `--config-dir <dir>` | Where state and backups are kept (default `~/.config/ready-set-mail`). |
| `--new-link` | Print a fresh setup link (15 minutes) for an installed instance, without redeploying. |
| `--uninstall` | Remove the instance (see [Uninstall](#uninstall)). `--no-export` skips the database export it makes first. |

**Agents and CI:** pass every input as a flag. Without a terminal the installer never prompts: it stops and names the missing flag (`--yes`, `--account-id`, or `--confirm` for uninstall), and exits non-zero with a plain message on any failure. Credentials come from `CLOUDFLARE_API_TOKEN` (see [Permissions](#permissions)) or an earlier `npx wrangler login`.

```sh
CLOUDFLARE_API_TOKEN=… npm run setup -- --name ready-set-mail --account-id <id> --yes --json
```

The last line of standard output is `{"ok":true,"name":…,"url":…,"setup_link":…,"proof_file":…,…}` or `{"ok":false,"error":…}`. `setup_link` is the owner's setup link and `setup_link_expires_at` when it stops working; hand the link to the person who will own the instance.

## What the installer does

1. **Checks** your Node version and that Wrangler is installed.
2. **Checks your Cloudflare credential** and lists the accounts it can see. It never guesses an account: with several, it asks (or, without a terminal, asks for `--account-id`).
3. **Checks the names.** If the account already has a Worker, D1 database or KV namespace with the instance's names that this installer did not create, it stops and changes nothing. It never replaces a Worker it did not create. It reads the account's workers.dev subdomain and works out the address: `https://<name>.<subdomain>.workers.dev`.
4. **Shows the plan** (account, names, address, what will be created, the scheduled jobs) and asks once.
5. **Creates** the D1 database and the KV namespace, and writes `wrangler.local.jsonc` in your checkout: the tracked `wrangler.jsonc` with your names, ids, account, `BETTER_AUTH_URL` and `WORKER_NAME` filled in, the workers.dev address on (off if the account has none) and preview URLs off. The tracked `wrangler.jsonc` leaves `workers_dev` unset, so an instance on its own domain is not changed by it. The six rate limits get namespace ids of their own (derived from the instance name, moved past any id another Worker in the account uses), so two instances in one account never share counters. That file is git-ignored; the tracked file is never edited, so `git pull` stays clean.
6. **Generates two secrets** without printing them, and backs them up to `~/.config/ready-set-mail/<name>/` (folder mode 0700, files 0600; existing files are never overwritten):
   - `bootstrap-proof`: the first-owner secret (`BOOTSTRAP_SECRET`). Setup links are signed with it; it is only needed until you have created your owner account.
   - `token-encryption-key`: `TOKEN_ENCRYPTION_KEY`, which encrypts the Cloudflare credentials you connect in the dashboard. Keep the backup: without it, Cloudflare connections have to be made again.

   The Worker's session-signing secret is not one of them: the Worker generates its own and keeps it in D1.
7. **Builds** the dashboard, **applies the database migrations**, and **deploys**. The secrets go up with the first version of the Worker (`wrangler deploy --secrets-file`, from a temporary 0600 file in the private folder that is deleted right after). So the Worker never runs without them, and no empty placeholder Worker is created first, which is what `wrangler secret put` before a first deploy would do.
8. **Verifies**: `/health` answers, the database's newest migration is the one this code needs, and the instance reports that it is waiting for its first owner.
9. **Prints** the address and the setup link, then where the backups are and how to upgrade and remove it.

The database and namespace are recorded in `~/.config/ready-set-mail/<name>/state.json` the moment they exist; the Worker is recorded after its deploy succeeds, with the creation time Cloudflare reports. On `--resume`, a Worker with the instance's name is only deployed over if it is that recorded Worker, or if it is bound to the recorded database and namespace (a deploy that was interrupted after Cloudflare created it). Any other Worker with the name stops the run. If a run stops (network, a typo in a token, a failed build), fix the cause and run the same command with `--resume`: it continues without creating anything twice. Tool output goes to `setup.log` in the same folder.

## Permissions

There are two different tokens, and you may need neither.

**1. To install (deploy).** `npx wrangler login` is enough: the installer uses that login. Only for CI, agents or a machine without a browser, create an API token instead (dash.cloudflare.com → My Profile → API Tokens → Create Token; the "Edit Cloudflare Workers" template plus D1 covers it) and set it as `CLOUDFLARE_API_TOKEN`:

| Scope | Permission | Why |
|---|---|---|
| Account | Account Settings: Read | List the accounts the token can reach, so the right one is used |
| Account | Workers Scripts: Edit | See which Worker names are taken, read the workers.dev subdomain, deploy the Worker and its secrets, delete it on uninstall |
| Account | D1: Edit | Create the database, apply migrations, check the newest migration, delete it on uninstall |
| Account | Workers KV Storage: Edit | Create the `OAUTH_KV` namespace (agent sign-in storage), delete it on uninstall |

This token stays on your machine or in your CI secrets. The Worker never sees it.

**2. Optional: for the Worker to change DNS for you.** Without it, Ready Set Mail still checks your domains and shows the exact DNS records to add by hand. With it, the dashboard can add DMARC, SPF and MTA-STS records, set up Email Routing for the reports address, and keep a flattened SPF record current. The way to add it is **Connect Cloudflare** in the dashboard (paste a token or, where offered, sign in with Cloudflare); it is stored encrypted with `TOKEN_ENCRYPTION_KEY`. The installer does not ask for it. Create it as a separate token, limited to the zones you monitor:

| Scope | Permission | Why |
|---|---|---|
| Zone | Zone: Read | Find the zone a domain belongs to |
| Zone | DNS: Edit | Write DMARC, SPF, MTA-STS, TLS-RPT and report-authorization records; refresh flattened SPF daily |
| Zone | Email Routing Rules: Edit | Turn on Email Routing for the reports domain and send its catch-all to the Worker |
| Account | Email Routing Addresses: Edit | Register your address as a verified destination for alerts and password resets |
| Account | Account Settings: Read | Find the account that owns a zone (destination addresses live on the account) |
| Zone | Workers Routes: Read | Use your own route as the MTA-STS host when you have one (otherwise the workers.dev address is used) |
| Account | Workers Scripts: Edit | Only for **Settings → Custom domain**, which attaches a hostname to the Worker. Leave it out if you attach domains yourself |

A self-hosted instance can also take this token as the Worker secret `CLOUDFLARE_API_TOKEN` (`npm run wrangler -- secret put CLOUDFLARE_API_TOKEN`); it then appears in the dashboard as the server's own connection and cannot be edited there.

## Scheduled jobs

The Worker runs five cron triggers (times in UTC). They start when it is deployed, and do nothing until there are domains to work on.

| Cron | When | What |
|---|---|---|
| `0 8 * * *` | daily 08:00 | Re-reads each domain's DNS (SPF lookup count, DMARC policy), runs monitor checks and change alerts, rollout regression checks, MTA-STS MX refresh |
| `0 9 * * 1` | Mondays 09:00 | Weekly DMARC digest email |
| `0 10 * * *` | daily 10:00 | SPF flattening refresh, only for domains that turned flattening on |
| `0 11 * * *` | daily 11:00 | Usage heartbeat, sent only if the owner opted in to telemetry |
| `0 4 * * *` | daily 04:00 | Data lifecycle: retries failed Cloudflare revocations, then deletes data past its retention period ([data retention](data-retention.md)) |

## Upgrade

```sh
git pull && npm install && npm run deploy
```

`npm run deploy` builds the dashboard, applies new migrations, then deploys, using your `wrangler.local.jsonc`. Until the migrations are applied the Worker answers 503 and inbound report mail is refused for the sender to retry, so do not deploy without them. Back up the database first if you want a rollback point: `npm run wrangler -- d1 export DB --remote --output backup.sql`. Details and rollback: [packages/db/UPGRADING.md](../packages/db/UPGRADING.md).

`GET /api/version` on your instance compares its version with the repository's.

## Uninstall

1. In the dashboard, export what you want to keep (each domain → Settings → Export), then delete each domain: that removes the DNS records it added.
2. Remove the reports address from each domain's `_dmarc` record.
3. Run:

   ```sh
   npm run setup -- --uninstall --name ready-set-mail
   ```

   It lists exactly what it will delete (the Worker, the D1 database with all its data, the KV namespace, and `wrangler.local.jsonc`), and asks you to type the instance name. It deletes only resources its state file recorded, and only while they still have the recorded ids. The Worker must also still be the one it deployed: same creation time, bound to the recorded database and namespace. Otherwise it stops and deletes nothing. Before deleting, it exports the database (`wrangler d1 export`) to `~/.config/ready-set-mail/<name>/removed-<date>/`, and moves the state, the log and both secret backups into that same folder; `--no-export` skips the export. Without a terminal, pass `--confirm <name>`.
4. Optional: in Cloudflare, delete the Email Routing catch-all rule and MX records for the reports domain, and any API tokens you created. Delete the `removed-<date>` folder when you no longer need the backups and the export. Installing the same name again starts fresh.

## Manual install

The installer does nothing you cannot do by hand. These steps produce the same result.

1. `npm install`, then `npx wrangler login`.
2. Pick an instance name (here `ready-set-mail`) and check that your account has no Worker, D1 database or KV namespace with it. Deploying under the name of an existing Worker **replaces that Worker**.
3. Create the resources and note their ids:

   ```sh
   npx wrangler d1 create ready-set-mail
   npx wrangler kv namespace create ready-set-mail-oauth
   ```

   Decline Wrangler's offer to add them to the config: the bindings must be named `DB` and `OAUTH_KV`, which step 4 does.
4. Copy `wrangler.jsonc` to `wrangler.local.jsonc` (git-ignored) and in the copy set: `name` and `vars.WORKER_NAME` to the instance name; `account_id` to your account id; `d1_databases[0].database_name` and `database_id`; `kv_namespaces[0].id`; and `vars.BETTER_AUTH_URL` to the address the Worker will serve, `https://<name>.<subdomain>.workers.dev`. Your workers.dev subdomain is shown on the Workers & Pages overview in the Cloudflare dashboard. A custom domain works too; the value must be an origin with no path. Leave the tracked `wrangler.jsonc` unchanged.
5. Generate the two secrets into a private file, without printing them:

   ```sh
   mkdir -p ~/.config/ready-set-mail/ready-set-mail && chmod 700 ~/.config/ready-set-mail/ready-set-mail
   (umask 077; set -C; node -e 'const c=require("crypto");process.stdout.write(JSON.stringify({BOOTSTRAP_SECRET:c.randomBytes(32).toString("hex"),TOKEN_ENCRYPTION_KEY:"k1:"+c.randomBytes(32).toString("base64")}))' > ~/.config/ready-set-mail/ready-set-mail/secrets.json)
   ```

   Keep this file: `TOKEN_ENCRYPTION_KEY` cannot be recovered from Cloudflare.
6. Build, migrate and deploy with the secrets in the first version:

   ```sh
   npm run build:dashboard
   npm run migrate
   npm run wrangler -- deploy --secrets-file ~/.config/ready-set-mail/ready-set-mail/secrets.json
   ```

   Do not run `wrangler secret put` before the first deploy: it creates an empty Worker under that name.
7. Check `https://<your address>/health` answers `{"ok":true,…}`, then open the address and create the owner account, entering the `BOOTSTRAP_SECRET` value from the file as the installer proof.

Later upgrades are the same as for an installer-made instance: `git pull && npm install && npm run deploy`.

**GitHub Actions.** The manual `Deploy` workflow (`.github/workflows/deploy.yml`) deploys the tracked `wrangler.jsonc`, so it only works in a fork whose `wrangler.jsonc` carries that fork's own ids and origin. It needs the `CLOUDFLARE_API_TOKEN` (the install token above) and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

**Deploy to Cloudflare button.** There is none: a one-click deploy cannot set the address, the owner proof or the encryption key, so it left an instance nobody could finish setting up. Use the installer.

## Troubleshooting

| You see | Do this |
|---|---|
| `This account already has a Worker named …` | Another instance (or another project) uses the name. Pick another with `--name`. |
| `An earlier install of "<name>" is recorded` | Run the same command with `--resume`, or uninstall it first. |
| `This account has no workers.dev subdomain yet` | Open Workers & Pages in the Cloudflare dashboard once and choose a subdomain, or pass `--url`. |
| `/health did not answer correctly (HTTP 503 …)` | Migrations are missing: run `npm run migrate`, or the installer again with `--resume`. |
| `wrangler.local.jsonc … belongs to the instance "<other>"` | One checkout deploys one instance. Clone the repository again for a second instance. |
| `npm run deploy` warns `"unsafe" fields are experimental` | Expected: the request rate limits are declared as Wrangler `unsafe` bindings. Nothing to do. |
| `wrangler.jsonc still has the REPLACE_WITH_… placeholder ids` | `npm run deploy` found no `wrangler.local.jsonc`: run `npm run setup`, or follow [Manual install](#manual-install). |
