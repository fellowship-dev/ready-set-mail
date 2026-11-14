import { IconButton, toast } from '@ready-set-mail/ui';
import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';

async function copy(value: string) {
	try {
		await navigator.clipboard.writeText(value);
		toast({ title: 'Copied to clipboard', variant: 'success', duration: 2000 });
	} catch {
		toast({ title: 'Could not copy', description: 'Select the text and copy it by hand.', variant: 'warning' });
	}
}

/** One labelled line of the record: the whole value is always visible (it wraps, never clips), with its own copy button. */
function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-start gap-x-2">
			<span className="pt-1.5 text-xs font-semibold uppercase tracking-wide text-ink-2">{label}</span>
			<code className="min-w-0 py-1 font-mono text-sm text-ink-1 [overflow-wrap:anywhere]">{value}</code>
			<IconButton size="sm" label={`Copy ${label.toLowerCase()}`} onClick={() => void copy(value)}>
				<Copy aria-hidden />
			</IconButton>
		</div>
	);
}

/**
 * The TXT record that proves a domain: type, name, value on three compact lines. `names` are the Name rows (label + value);
 * several rows mean the provider's host field is not known, so both forms are shown.
 */
export function ProofRecord({ names, value, children }: { names: Array<{ label: string; value: string }>; value: string; children?: ReactNode }) {
	return (
		<div className="space-y-2">
			<div className="space-y-0.5 rounded-md border border-line bg-surface-2 px-3 py-1.5" role="group" aria-label="DNS record to add">
				<Row label="Type" value="TXT" />
				{names.map((n) => (
					<Row key={n.label} label={n.label} value={n.value} />
				))}
				<Row label="Value" value={value} />
			</div>
			{children}
		</div>
	);
}
