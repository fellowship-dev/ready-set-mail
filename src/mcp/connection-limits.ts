// How many apps one person, one workspace and the whole instance may keep connected, and what happens to a connection after it ends (ADR 0022).
// The numbers are hypotheses (nothing measured yet: the hosted service has no agent traffic); each says what would change it.
//   - perPerson 20 live apps: a person uses a handful of assistants (Claude, ChatGPT, Cursor, VS Code, a script of their own), a few installs of each; 20 leaves
//     room for all of that several times over. Change it if support hears from people who hit it with apps they actually use.
//   - perWorkspace 50 live apps: a few people, each with their handful. Change it for the same reason, or when a workspace of many people is common.
//   - perPersonPerDay 20 approvals in 24 hours: connecting again after a link expired, trying an app, reconnecting after a revoke: a few a day at most. It is what
//     stops one account from approving and revoking in a loop. Revoked ones still count for the day, so it needs their records to be kept at least that long.
//   The audit log gets `agent.approval_limit_reached` (who, which limit), so how often a limit is hit can be counted before anyone changes a number.
// The consent page says which limit was reached and what to do, the same on the hosted service and self-hosted.
import { accessLookups } from '@ready-set-mail/db';
import type { BoundEnv } from '../index';
import { logAudit } from '../audit/log';
import { CONNECTION_PREFIX, scheduledContext } from './registration';

export const APPROVAL_LIMITS = { perPerson: 20, perWorkspace: 50, perPersonPerDay: 20 } as const;
/**
 * How long an ended connection's record (revoked, or past its end date) is kept before the daily clean-up deletes it, with its registered app when no connection
 * of it remains. Seven days: the per-day approval limit needs the last day's; a person can see in Settings → Agents that they revoked it and when; the audit log
 * keeps the history (what it keeps and for how long: docs/agent-operations.md).
 */
export const CONNECTION_RETENTION_DAYS = 7;
const DAY_SECONDS = 86_400;

export type ApprovalLimit = 'person' | 'workspace' | 'day';
/** Said on the consent page when a limit is reached: what the limit is, and what the person can do. Plain words; the same in every mode. */
export const LIMIT_SENTENCES: Readonly<Record<ApprovalLimit, string>> = Object.freeze({
  person: `You already have ${APPROVAL_LIMITS.perPerson} apps connected, which is the most one person can have at once. Open Settings, then Agents, and revoke one you no longer use. Then connect this app again.`,
  workspace: `This workspace already has ${APPROVAL_LIMITS.perWorkspace} apps connected, which is the most it can have at once. Open Settings, then Agents, and revoke one you no longer use, or ask a teammate to revoke theirs. Or choose another workspace.`,
  day: `You have approved ${APPROVAL_LIMITS.perPersonPerDay} apps in the last 24 hours, which is the most one person can approve in a day. Try again tomorrow.`,
});

/**
 * Which limit this person has reached, if any. `workspaceIds` are the workspaces the approval would be recorded in (none when the page is first shown: the
 * workspace is chosen later). Soft: two approvals at the same moment can both pass.
 */
export async function approvalLimitReached(env: Pick<BoundEnv, 'DB'>, userId: string, workspaceIds: readonly string[], nowSeconds = Math.floor(Date.now() / 1000)): Promise<ApprovalLimit | null> {
  const lookups = accessLookups(env.DB);
  const mine = await lookups.connectionsOfPerson(CONNECTION_PREFIX, userId, nowSeconds, nowSeconds - DAY_SECONDS);
  if (mine.live >= APPROVAL_LIMITS.perPerson) return 'person';
  for (const id of new Set(workspaceIds)) if (await lookups.liveConnectionsInWorkspace(CONNECTION_PREFIX, id, nowSeconds) >= APPROVAL_LIMITS.perWorkspace) return 'workspace';
  if (mine.approvedSince >= APPROVAL_LIMITS.perPersonPerDay) return 'day';
  return null;
}

/** Records that ended, looked at at once (below D1's 100 bound values), and what one run may delete: records, and registered apps (each is one KV delete). */
const ENDED_BATCH = 50, ENDED_MAX_RECORDS = 400, ENDED_MAX_APPS = 200, ENDED_BUDGET_MS = 25_000;

export interface EndedSweep { removed: number; appsDeleted: number; truncated: boolean }

/**
 * The daily clean-up of ended connections: delete the record and principal of every connection revoked or past its end date more than CONNECTION_RETENTION_DAYS ago
 * (its grants go with the principal), then the registered app of each when no connection of that app remains. Oldest first, in batches, until none are due or the
 * run has used its share of the invocation's subrequests or time. Each is written to the audit log.
 */
export async function sweepEndedConnections(env: Pick<BoundEnv, 'DB' | 'OAUTH_KV'>, now = Date.now(), clock: () => number = Date.now): Promise<EndedSweep> {
  const { ctx, settle } = scheduledContext();
  const lookups = accessLookups(env.DB), cutoff = Math.floor(now / 1000) - CONNECTION_RETENTION_DAYS * DAY_SECONDS, started = clock();
  let removed = 0, appsDeleted = 0, truncated = false;
  try {
    for (;;) {
      if (removed >= ENDED_MAX_RECORDS || appsDeleted >= ENDED_MAX_APPS || clock() - started > ENDED_BUDGET_MS) { truncated = true; break; }
      const due = await lookups.endedConnections(CONNECTION_PREFIX, cutoff, ENDED_BATCH);
      if (!due.length) break;
      await lookups.deleteConnections(due);
      removed += due.length;
      // A registered app has an id that is not an address; one with a client document is not stored by us.
      const ids = [...new Set(due.map(d => d.client_id).filter((id): id is string => !!id && !id.startsWith('https://')))];
      const kept = await lookups.connectedClientIds(CONNECTION_PREFIX, ids);
      const orphaned = ids.filter(id => !kept.has(id));
      for (const id of orphaned) await env.OAUTH_KV!.delete(`client:${id}`);
      appsDeleted += orphaned.length;
      for (const d of due) {
        logAudit({ db: env.DB, workspaceId: d.workspace_id }, { actor_type: 'system', action: 'agent.connection_removed', resource_type: 'agent_connection', resource_id: d.principal_id, meta: { reason: d.reason, client_id: d.client_id, app_deleted: !!d.client_id && orphaned.includes(d.client_id) } }, ctx);
      }
    }
    return { removed, appsDeleted, truncated: truncated && (await lookups.endedConnections(CONNECTION_PREFIX, cutoff, 1)).length > 0 };
  } finally { await settle(); }
}
