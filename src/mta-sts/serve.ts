// Serving the policy (RFC 8461 §3.2, §3.3): `https://mta-sts.<domain>/.well-known/mta-sts.txt`, from this Worker.
//
// A policy host answers ONE request: GET (or HEAD) of that path, for a domain that is live, proven (hosted) and has MTA-STS on. Every other request on an
// `mta-sts.*` hostname is a 404: the dashboard, the API and the assets are not served under a customer's name. The answer is never cached: senders must
// see a changed policy as soon as the `_mta-sts` id changes (RFC 8461 §8.1), and they may not use HTTP caching themselves (§3.3).

import { assertSchemaReady, intakeLookups, SchemaNotReadyError, type MtaStsRow } from '@ready-set-mail/db';
import { buildPolicyFile } from '@ready-set-mail/dns-checks';
import type { Env } from '../index';
import { scope } from '../db/scope';
import { resolveDomainOwner } from '../tenancy/resolver';
import { maxAgeFor } from './config';
import { splitHosts } from './evidence';

const POLICY_PATH = '/.well-known/mta-sts.txt';
const notFound = (text = 'Not found') => new Response(text, { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });

// Which tenant serves an MTA-STS policy hostname:
//   self-host   mta-sts.<domain>            → the workspace monitoring that domain, else the implicit workspace
//   saas        mta-sts.<customer domain>   → the workspace that owns the domain by the one proven-owner rule (packages/db `provenOwnerOf`, the rule report intake uses): the
//               domain is live and proven. Never the default workspace in saas: an unknown or unproven host is a 404 (a policy being RETIRED is the exception, see below).
export interface PolicyHost { workspaceId: string; domain: string }

export async function resolvePolicyHost(env: Env, hostname: string): Promise<PolicyHost | null> {
  const host = hostname.toLowerCase();
  if (!host.startsWith('mta-sts.')) return null;
  const domain = host.slice('mta-sts.'.length);
  const owner = await resolveDomainOwner(env, domain);
  return owner ? { workspaceId: owner, domain } : null;
}

/** The mode the policy file says. */
export const servedMode = (config: Pick<MtaStsRow, 'mode'>): 'testing' | 'enforce' | 'none' => config.mode;

/** The policy file of a stored config: its mode, its MX hosts and the max_age OF THAT MODE (one place builds it; the row's own max_age column is only a copy). */
export function policyText(config: Pick<MtaStsRow, 'mode' | 'mx_hosts'>): string {
  const mode = servedMode(config);
  return buildPolicyFile(mode, splitHosts(config.mx_hosts), maxAgeFor(mode));
}

/** The policy of a domain being retired (src/mta-sts/retire.ts): `none`, with its MX hosts, for a day (RFC 8461 section 8.3). */
export const retiringPolicyText = (e: { mx_hosts: string }): string => buildPolicyFile('none', splitHosts(e.mx_hosts), maxAgeFor('none'));

/** Is this an MTA-STS policy hostname (`mta-sts.<something>`)? */
export const isPolicyHostname = (hostname: string): boolean => hostname.toLowerCase().startsWith('mta-sts.');

/**
 * The Worker with policy hosts answered FIRST, before anything else looks at the request (the OAuth/MCP layer, the relay, llms.txt, the API, the dashboard):
 * a customer's `mta-sts.<domain>` serves the policy file and 404s every other path that REACHES the Worker, whatever else this Worker serves on its own host.
 * What reaches it is decided before this code: `/.well-known/*` is in wrangler.jsonc `assets.run_worker_first`, so the policy path always runs the Worker; a path
 * not in that list is answered by the static assets (the dashboard's single-page fallback) when a request for it reaches this Worker's version at all.
 * On the hosted service only the one declared route (`*\/.well-known/mta-sts.txt`) sends a customer's host here; self-host: docs/mta-sts.md "Other paths".
 */
export function withPolicyHostFirst<T extends { fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> }>(worker: T): T {
  return { ...worker, async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (!isPolicyHostname(new URL(request.url).hostname)) return worker.fetch(request, env, ctx);
    if (!env.DB) return notFound();
    try {
      await assertSchemaReady(env.DB);
    } catch (e) {
      if (e instanceof SchemaNotReadyError) return new Response(e.message, { status: 503 });
      throw e;
    }
    return servePolicyHost(request, env as Env & { DB: D1Database });
  } };
}

/** The `none` policy of a name whose MTA-STS is being retired, whoever's it was and whether or not the domain still exists or is proven; null when nothing retires there. */
async function retiringText(env: Env & { DB: D1Database }, hostname: string): Promise<string | null> {
  const name = hostname.toLowerCase().replace(/^mta-sts\./, '');
  const entry = await intakeLookups(env.DB).retiringPolicy(name);
  return entry ? retiringPolicyText(entry) : null;
}

/** The response for any request on a policy hostname. `env.DB` must be present. */
export async function servePolicyHost(request: Request, env: Env & { DB: D1Database }): Promise<Response> {
  const url = new URL(request.url);
  const head = request.method === 'HEAD';
  if (url.pathname !== POLICY_PATH || (request.method !== 'GET' && !head)) return notFound();
  const host = await resolvePolicyHost(env, url.hostname);
  const config = host && await scope(env.DB, host.workspaceId).mtaSts.getEnabledByDomain(host.domain);
  const text = config ? policyText(config) : await retiringText(env, url.hostname);
  if (text === null) return notFound('MTA-STS not configured for this domain');
  return new Response(head ? null : text, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
}
