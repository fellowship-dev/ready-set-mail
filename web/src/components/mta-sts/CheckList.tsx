import { StatusDot, type StatusDotStatus } from '@ready-set-mail/ui';
import { CHECK_WORDS } from '../../lib/mta-sts';
import type { MtaStsCheck, MtaStsCheckState } from '../../lib/types';

const DOT: Record<MtaStsCheckState, StatusDotStatus> = { ok: 'ok', pending: 'unknown', missing: 'warn', wrong: 'fail', error: 'unknown', not_applicable: 'info' };

/** The setup checks of the last "Check now": each line says what was looked at and what was found, in words. */
export function CheckList({ checks }: { checks: MtaStsCheck[] }) {
	return (
		<ul aria-label="Setup checks" className="space-y-2">
			{checks.filter((c) => c.state !== 'not_applicable').map((c) => (
				<li key={c.key} className="space-y-0.5">
					<p className="text-sm font-medium text-ink-1">{c.label}</p>
					<StatusDot status={DOT[c.state]} label={CHECK_WORDS[c.state]} />
					{c.detail ? <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">{c.detail}</p> : null}
				</li>
			))}
		</ul>
	);
}
