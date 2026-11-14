# For coding agents: setting up DMARC monitoring with Ready Set Mail

Read this when a person asks you to "set up DMARC monitoring for my domain", "check my SPF/DKIM/DMARC", or "self-host this". It says what running Ready Set Mail takes, what it costs the person, and the exact steps. Everything here is true for the code in this repository; where something depends on how an installation is configured, it says so.

**Hosted service:** none. Ready Set Mail runs on the person's own Cloudflare account; follow the self-hosting steps below. Do not send anyone to a sign-up page or invent a URL. If an installation's `/llms.txt` or MCP server instructions name a hosted service URL, that installation's operator configured it.

## What self-hosting costs the person

- **Money:** whatever Cloudflare charges for Workers, D1, KV and email under the person's plan and usage. Cloudflare bills them directly; this project charges nothing. Sending mail to arbitrary recipients (free email check replies, alerts to unverified addresses) uses Cloudflare Email Service, which needs a Workers Paid plan and an onboarded sending domain. Without it, outbound mail only reaches verified Email Routing destination addresses. Check Cloudflare's current pricing; this document makes no price claims.
- **What they need:**
  - a Cloudflare account holding a Worker, a D1 database and a KV namespace (`OAUTH_KV`);
  - a Cloudflare login (`npx wrangler login`) or an install token ([permissions](self-hosting.md#permissions)); the token the Worker uses to write DNS is optional and is added later in the dashboard;
  - for one-click DNS changes to a monitored domain: that domain's DNS on Cloudflare. On any other DNS host the dashboard shows the records to copy by hand;
  - for DMARC report ingestion: Cloudflare Email Routing on the reports domain (MX records and a rule to the Worker). The `_report._dmarc` authorization records also live in the reports domain's zone, not in the monitored domain's zone, so a monitored domain on external DNS can still have its reports ingested by adding the reports address to its own DMARC record;
  - Node.js 22.22.2 or newer and git. Wrangler comes with `npm install`.
- **Time and steps:** one command (`npm run setup`), one click on the setup link, then the domain steps in the dashboard, then DNS propagation, which takes from seconds to hours depending on the DNS host. Reports arrive only after receivers start sending them, usually daily.
- **Ongoing:** they run upgrades: `git pull && npm install && npm run deploy` (it migrates before deploying). `GET /api/version` on the installation says when a newer release exists. Until migrations run, the Worker answers 503 and inbound report mail is refused for retry.
- **Support:** none guaranteed. The software is MIT licensed and provided as is, with no warranty, support agreement or uptime commitment. They can open an issue on GitHub.

## Exact steps

1. In a clone of this repository: `npm install`, then `npm run setup`. Without a terminal, pass every input as a flag: `npm run setup -- --yes --json` plus `--account-id <id>` when the credential sees several accounts ([options](self-hosting.md#options)). It refuses names already used in the account; choose another with `--name`.
2. Give the person the setup link the installer printed (the `setup_link` field with `--json`) and tell them that whoever opens it first becomes the owner. **Never ask for the proof or a password in chat**, and never put either anywhere else: not in a log, a commit, an issue or another URL.
3. The person adds the domain in the dashboard and follows its steps. DNS changes from the dashboard need **Connect Cloudflare**; without it, the dashboard shows the records to add by hand.
4. To use the MCP server, follow [first useful report](agent-operations.md#first-useful-report).

The installer verifies `/health`, the database migrations and that the instance waits for its owner. Verify the rest from outside before calling it done: the owner can sign in, the domain shows live DNS findings.

## Rules while helping

- Show the exact DNS records and ask before anyone changes DNS or tightens DMARC from `p=none` toward `quarantine` or `reject`. The MCP tools never change DNS or send mail.
- Report missing data as unavailable, never as zero or as a pass.
- Do not promise inbox placement. Authentication can be fixed and verified; reputation takes weeks and is not guaranteed.
- Do not invent limits, prices, support promises or scale numbers. If a fact is not in this repository, say you don't know.
