import { RecordBlock } from '@ready-set-mail/ui';
import type { MtaStsRecord } from '../../lib/types';

/** The three records, exactly as they are or will be written. A record Ready Set Mail writes itself has nothing to copy. */
export function RecordList({ records, copyable, label }: { records: MtaStsRecord[]; copyable: boolean; label: string }) {
	return (
		<ul aria-label={label} className="space-y-3">
			{records.map((r) => (
				<li key={r.purpose}>
					<RecordBlock
						record={{ type: r.type, name: r.name, value: r.value ?? '(could not be read: the server will say when you turn it on)' }}
						copyable={copyable && r.value !== null}
					/>
				</li>
			))}
		</ul>
	);
}
