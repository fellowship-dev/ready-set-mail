import { RecordBlock } from '@ready-set-mail/ui';
import type { MtaStsRecord } from '../../lib/types';

const PLAIN: Record<MtaStsRecord['purpose'], string> = {
	policy_host: 'Points the policy name at the server that serves your policy.',
	tls_rpt: 'Tells senders where to send their reports.',
	policy_id: 'Tells senders a policy exists, and changes whenever the policy does.',
};

/** The three records, exactly as they are or will be written. A record Ready Set Mail writes itself has nothing to copy. */
export function RecordList({ records, copyable, label }: { records: MtaStsRecord[]; copyable: boolean; label: string }) {
	return (
		<ul aria-label={label} className="space-y-3">
			{records.map((r) => (
				<li key={r.purpose} className="space-y-1.5">
					<p className="text-sm text-ink-2">{PLAIN[r.purpose]}</p>
					<RecordBlock
						record={{ type: r.type, name: r.name, value: r.value ?? '(could not be read: the server will say when you turn it on)' }}
						copyable={copyable && r.value !== null}
					/>
					{r.note ? <p className="text-xs text-ink-2">{r.note}</p> : null}
				</li>
			))}
		</ul>
	);
}
