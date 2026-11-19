// "First report received": sent once per domain, when the first COUNTED aggregate report is stored.
//
// One module for both modes. The email itself (who gets it, its words, the claim that makes it once, the sender) is
// src/lifecycle/email/: on the hosted service the sender is the platform's (src/mail/compliance.ts `accountSender`, because a workspace has no sender
// of its own there), on self-host the workspace's own `fromEmail` when it has one; the link is the public origin (`appLink`). Called from storeReport (src/dmarc/store-report.ts) inside
// ctx.waitUntil, so the Worker is not stopped before the send finishes; src/lifecycle/email/run.ts catches up a first report this
// call missed.

import { sendFirstReportNow } from '../lifecycle/email/run';
import type { TenantContext } from '../tenancy/context';

/** Never throws: a notification must not fail the report it is about. */
export async function sendFirstReportNotification(
  tenant: TenantContext,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
  domainId: number,
  reportId: number,
): Promise<void> {
  try {
    await sendFirstReportNow(tenant, ctx, domainId, reportId);
  } catch (e) {
    console.error('[first-report] not sent:', e instanceof Error ? e.name : 'error');
  }
}
