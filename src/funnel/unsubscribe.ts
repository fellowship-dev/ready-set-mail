// Unsubscribe: one address leaves every list for good.

import { funnelQueries } from '@ready-set-mail/db';
import type { BoundEnv } from '../index';

export const normaliseEmail = (e: string): string => e.trim().toLowerCase();

/**
 * Unsubscribe: suppress the address for good, delete its lead row (the retired follow-up sequence left some; nothing writes new ones)
 * and its change-alert subscriptions. Idempotent.
 */
export async function unsubscribeEmail(env: Pick<BoundEnv, 'DB'>, rawEmail: string, reason = 'unsubscribe'): Promise<void> {
  const email = normaliseEmail(rawEmail);
  const q = funnelQueries(env.DB);
  await q.suppression.add(email, reason);
  await q.leads.delete(email);
  await q.deleteSubscriptionsFor(email);
}
