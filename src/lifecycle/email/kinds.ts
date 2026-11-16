// The lifecycle emails of the hosted service: what exists, who may get which, and the limits on how many go out.
//
// Principles (docs/hosted.md, "Lifecycle emails"): an email is sent because a stored fact became true, or verifiably did not happen by a
// deadline measured from a stored fact; never on a bare timer. Hosted only, except the first-report email, which is one module for both modes.

import type { Env } from '../../index';
import { LIFECYCLE_KINDS } from '../../product-analytics/events';
import { NO_REPORT_AFTER_SECONDS } from '../../product-analytics/steps';

export { LIFECYCLE_KINDS, NO_REPORT_AFTER_SECONDS };
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

export type LifecycleEnv = Pick<Env, 'LIFECYCLE_EMAILS_OFF' | 'LIFECYCLE_EMAILS_ON' | 'LIFECYCLE_TIPS_DEFAULT'>;

/**
 * The kinds the kill switch names (LIFECYCLE_EMAILS_OFF). The three tips are one switch. `change_alerts` and `connection_alerts` are the two
 * monitor emails of src/monitor/notify.ts: not lifecycle emails, but one list is one place to switch an account holder's mail off.
 */
export const SWITCHES = ['records_live', 'first_report', 'no_reports', 'summary', 'tips', 'change_alerts', 'connection_alerts'] as const;
export type Switch = (typeof SWITCHES)[number];
export const switchOf = (kind: LifecycleKind): Switch => (kind.startsWith('tip_') ? 'tips' : (kind as Switch));

/** Which preference a recipient can turn off (milestone emails have none: they are transactional). */
export const preferenceOf = (kind: LifecycleKind): 'summary' | 'tips' | null => (kind === 'summary' ? 'summary' : kind.startsWith('tip_') ? 'tips' : null);

/** The kinds stopped by LIFECYCLE_EMAILS_OFF: a comma list of switches, or `all`. Unknown words stop nothing. */
export function stoppedSwitches(env: LifecycleEnv): ReadonlySet<Switch> {
  const words = (env.LIFECYCLE_EMAILS_OFF ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (words.includes('all')) return new Set(SWITCHES);
  return new Set(SWITCHES.filter((s) => words.includes(s)));
}
export const stopped = (env: LifecycleEnv, kind: LifecycleKind): boolean => stoppedSwitches(env).has(switchOf(kind));

/**
 * Switches that are off until LIFECYCLE_EMAILS_ON names them, on the hosted service only: the change alerts, which ride the daily monitor job
 * (`0 8 * * *`, with the DNS refresh and the MTA-STS update) that an operator may need to run without them. LIFECYCLE_EMAILS_OFF always wins. Self-host: every switch is on unless LIFECYCLE_EMAILS_OFF names it.
 */
export const OFF_ON_HOSTED = ['change_alerts'] as const satisfies readonly Switch[];

/** Is this monitor email to be sent? (`hosted`: hostedEnabled(env).) */
export function alertEnabled(env: LifecycleEnv, hosted: boolean, which: 'change_alerts' | 'connection_alerts'): boolean {
  if (stoppedSwitches(env).has(which)) return false;
  if (!hosted || !(OFF_ON_HOSTED as readonly string[]).includes(which)) return true;
  return (env.LIFECYCLE_EMAILS_ON ?? '').split(',').some((w) => w.trim().toLowerCase() === which);
}

/** The default of the tips email for an owner who never chose: `LIFECYCLE_TIPS_DEFAULT` = off, else on. */
export const tipsDefaultOn = (env: LifecycleEnv): boolean => (env.LIFECYCLE_TIPS_DEFAULT ?? '').trim().toLowerCase() !== 'off';

// ── Limits ───────────────────────────────────────────────────

/** Lifecycle emails one scheduled invocation sends in all, over every workspace; the rest go out on the next run. */
export const MAX_LIFECYCLE_SENDS_PER_RUN = 100;
/** Lifecycle emails one person gets in one run. */
export const MAX_PER_RECIPIENT_PER_RUN = 3;
/** At most one tip per recipient in this many seconds (rolling). */
export const TIP_INTERVAL_SECONDS = 7 * 86400;
/** DNS reads one run makes for domains waiting to be seen live, and for no-report checks (each). */
export const MAX_LIVE_READS_PER_RUN = 25;
/** A domain is watched for its records going live for this long after it was added. */
export const LIVE_WATCH_SECONDS = 30 * 86400;
/** "Records live" is only worth sending while it is news. */
export const LIVE_EMAIL_MAX_AGE_SECONDS = 7 * 86400;
/** The first-report catch-up (the job's net under the real-time send) covers a first counted report this young. */
export const FIRST_REPORT_CATCHUP_SECONDS = 3 * 86400;
/** A tip names a source only when it sent at least this many messages that did not pass. */
export const TIP_MIN_MESSAGES = 10;
