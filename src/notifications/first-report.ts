// "First report received": sent once per domain, when the first COUNTED aggregate report is stored.
//
// One module for both modes. The email itself (who gets it, its words, the claim that makes it once, the sender) is
// src/lifecycle/email/: on the hosted service the sender is the platform's (src/auth/mail.ts `senderAddress`, because a workspace has no sender
// of its own there), on self-host the workspace's own `fromEmail` when it has one. Called from storeReport (src/dmarc/store-report.ts) inside
// ctx.waitUntil, so the Worker is not stopped before the send finishes; src/lifecycle/email/run.ts catches up a first report this
// call missed.

import { publicBaseUrl } from '../funnel/config';
import { sendFirstReportNow } from '../lifecycle/email/run';
import type { TenantContext } from '../tenancy/context';

/** Where the dashboard is: the instance's public address, else (self-host) its custom domain, else its workers.dev address. */
async function dashboardBase(tenant: TenantContext): Promise<string | null> {
  const configured = publicBaseUrl(tenant.env);
  if (configured) return configured;
  const custom = await tenant.scope.settings.get('custom_domain');
  if (custom?.value) return `https://${custom.value}`;
  const subdomain = await tenant.workersSubdomain();
  return subdomain ? `https://${tenant.workerName}.${subdomain}.workers.dev` : `https://${tenant.workerName}.workers.dev`;
}

/** Never throws: a notification must not fail the report it is about. */
export async function sendFirstReportNotification(
  tenant: TenantContext,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
  domainId: number,
  reportId: number,
): Promise<void> {
  try {
    await sendFirstReportNow(tenant, ctx, domainId, reportId, await dashboardBase(tenant));
  } catch (e) {
    console.error('[first-report] not sent:', e instanceof Error ? e.name : 'error');
  }
}
