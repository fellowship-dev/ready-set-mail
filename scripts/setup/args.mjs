// Flag parsing for `npm run setup`. No dependencies: node:util parseArgs with strict checking.
import { parseArgs as nodeParseArgs } from 'node:util';

export const DEFAULT_NAME = 'ready-set-mail';

export const USAGE = `Usage: npm run setup -- [options]

Installs Ready Set Mail on your Cloudflare account: creates a D1 database and a KV namespace,
deploys the Worker, and prints the link that makes you its owner.

Options:
  --name <name>          Instance name: the Worker, D1 database and KV namespace are named after it
                         (default: ${DEFAULT_NAME})
  --account-id <id>      Cloudflare account to install into (default: CLOUDFLARE_ACCOUNT_ID, or the only
                         account your credential can see; asked when there are several)
  --url <https-origin>   Serve from your own domain instead of the workers.dev address
                         (you add the custom domain or route yourself)
  --yes, -y              Do not ask for confirmation
  --resume               Continue an interrupted install (uses the state file from the earlier run)
  --dry-run              Check everything and show the plan, then stop without changing anything
  --json                 Print one machine-readable JSON line at the end
  --config-dir <dir>     Where state and backups are kept (default: ~/.config/ready-set-mail)
  --new-link             Print a fresh owner setup link for --name (no redeploy)
  --uninstall            Delete what this installer created for --name (asks you to type the name)
  --confirm <name>       With --uninstall and no terminal: the name, typed in advance
  --help, -h             Show this help

Credentials: set CLOUDFLARE_API_TOKEN, or log in once with \`npx wrangler login\`.
`;

const OPTIONS = {
  name: { type: 'string' },
  'account-id': { type: 'string' },
  url: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  resume: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  'config-dir': { type: 'string' },
  uninstall: { type: 'boolean' },
  'new-link': { type: 'boolean' },
  confirm: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

export class UsageError extends Error {}

/** Worker names: lowercase letters, digits and dashes; the workers.dev hostname label caps them at 63. */
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateName(name) {
  if (!NAME_RE.test(name)) {
    throw new UsageError(`--name "${name}" is not usable: use 1-63 lowercase letters, digits and dashes, starting and ending with a letter or digit`);
  }
  return name;
}

/** An origin: https, no path, query, fragment or credentials (BETTER_AUTH_URL's rules). */
export function validateOrigin(value) {
  let u;
  try { u = new URL(value); } catch { throw new UsageError(`--url "${value}" is not a URL; use for example https://mail.example.com`); }
  if (u.protocol !== 'https:') throw new UsageError('--url must start with https://');
  if (u.username || u.password) throw new UsageError('--url must not contain a user name or password');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new UsageError('--url must be an origin only, without a path, query or fragment (for example https://mail.example.com)');
  return u.origin;
}

export function parseArgs(argv) {
  let parsed;
  try {
    parsed = nodeParseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
  } catch (e) {
    throw new UsageError(`${e.message.replace(/\. To specify.*$/s, '')}\n\nRun \`npm run setup -- --help\` for the options.`);
  }
  const v = parsed.values;
  const opts = {
    help: !!v.help,
    name: validateName(v.name ?? DEFAULT_NAME),
    accountId: v['account-id'] ?? null,
    url: v.url !== undefined ? validateOrigin(v.url) : null,
    yes: !!v.yes,
    resume: !!v.resume,
    dryRun: !!v['dry-run'],
    json: !!v.json,
    configDir: v['config-dir'] ?? null,
    uninstall: !!v.uninstall,
    newLink: !!v['new-link'],
    confirm: v.confirm ?? null,
  };
  if (opts.accountId !== null && !/^[0-9a-f]{32}$/.test(opts.accountId)) {
    throw new UsageError('--account-id must be a 32-character Cloudflare account ID');
  }
  if (opts.uninstall && (opts.url || opts.resume || opts.dryRun)) {
    throw new UsageError('--uninstall takes only --name, --account-id, --confirm, --yes, --json and --config-dir');
  }
  if (opts.newLink && (opts.uninstall || opts.url || opts.resume || opts.dryRun)) throw new UsageError('--new-link takes only --name, --json and --config-dir');
  if (opts.confirm !== null && !opts.uninstall) throw new UsageError('--confirm is only used with --uninstall');
  return opts;
}
