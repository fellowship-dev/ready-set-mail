// Operator alerts about a workspace's report volume (docs/adr/0016), each at most once per workspace per day, by email to OWNER_EMAIL through the
// existing notify path. Nothing here is shown to the customer: the only customer-facing words are the limit notice and the summarised-rows note.
//   heavy_passing   a FREE workspace's own mail passed more than the alert line (default 5,000 rows a day): "heavy legitimate user on the free plan"
//   spoofing        a workspace saw an extreme number of FAILING rows in a day (default 100,000): "this customer may be under a spoofing run"
import { globalQueries } from '@ready-set-mail/db';
import { emailOperator } from '../billing/notify';
import type { BoundEnv } from '../index';
import type { IntakeLimits } from './config';

const DAY_MS = 86_400_000;

export type VolumeAlert = 'heavy_passing' | 'spoofing';

export function alertText(kind: VolumeAlert, ws: { id: string; name: string | null }, n: number): { subject: string; text: string } {
  const where = `Workspace: ${ws.name ?? '(unnamed)'} (${ws.id})`;
  return kind === 'heavy_passing'
    ? { subject: `Heavy legitimate use on the free plan: ${ws.name ?? ws.id}`, text: [`A free workspace's own mail passed ${n} report rows today (alert line: the free plan takes 20,000).`, 'This is mail that passes authentication for the customer\'s own domain. It is the number the free plan counts.', '', where].join('\n') }
    : { subject: `This customer may be under a spoofing run: ${ws.name ?? ws.id}`, text: [`${n} report rows that FAIL authentication were seen for this workspace today.`, 'Failing mail never counts toward any plan limit. Reports keep being stored for the customer\'s own mail; the excess failing rows are summarised by source network.', '', where].join('\n') };
}

/** Send the alert unless this workspace already had this kind today. True when this call sent (or tried to send) it. */
export async function alertOperatorOnce(env: BoundEnv, kind: VolumeAlert, ws: { id: string; name: string | null }, n: number, nowMs = Date.now()): Promise<boolean> {
  const first = await globalQueries(env.DB).rateLimit.hitUnder(`opalert:${kind}:${ws.id}`, nowMs, DAY_MS, 1);
  if (!first) return false;
  await emailOperator(env, `${kind}:${ws.id}`, alertText(kind, ws, n)).catch(() => false);
  return true;
}

/** After a counted report was stored: check today's volume against the alert lines. `free`: the workspace is on the free plan. */
export async function checkVolumeAlerts(env: BoundEnv, ws: { id: string; name: string | null }, volume: { passing: number; failing: number }, limits: Pick<IntakeLimits, 'alertPassingRowsPerDay' | 'alertFailingRowsPerDay'>, free: boolean): Promise<VolumeAlert[]> {
  const sent: VolumeAlert[] = [];
  if (free && volume.passing > limits.alertPassingRowsPerDay && (await alertOperatorOnce(env, 'heavy_passing', ws, volume.passing))) sent.push('heavy_passing');
  if (volume.failing > limits.alertFailingRowsPerDay && (await alertOperatorOnce(env, 'spoofing', ws, volume.failing))) sent.push('spoofing');
  return sent;
}
