// Which tenant serves an MTA-STS policy hostname.
//
//   self-host   mta-sts.<domain>            → the workspace monitoring that domain, else the implicit workspace
//   saas        mta-sts.<customer domain>   → the workspace that owns the domain by the one proven-owner rule (packages/db `provenOwnerOf`,
//               the rule report intake uses): the domain is live and proven, so a lost proof stops the policy at once
//
// Never the default workspace in saas: an unknown or unproven host is a 404.

import type { Env } from '../index';
import { resolveDomainOwner } from '../tenancy/resolver';

export interface PolicyHost { workspaceId: string; domain: string }

export async function resolvePolicyHost(env: Env, hostname: string): Promise<PolicyHost | null> {
  const host = hostname.toLowerCase();
  if (!host.startsWith('mta-sts.')) return null;
  const domain = host.slice('mta-sts.'.length);
  const owner = await resolveDomainOwner(env, domain);
  return owner ? { workspaceId: owner, domain } : null;
}
