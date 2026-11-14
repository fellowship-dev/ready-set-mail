import { IconButton, toast } from '@ready-set-mail/ui';
import { Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';

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
 * The TXT record that proves a domain: type, name, value on three compact lines, with ONE name. `prefer` is what the
 * detected provider wants typed: `short` (`_readysetmail`, the provider adds the domain) or `full`; `unknown` shows the
 * full name with a quiet line about the short one. The other form is a toggle away.
 */
export function ProofRecord({ shortName, fullName, prefer, value, children }: { shortName: string; fullName: string; prefer: 'short' | 'full' | 'unknown'; value: string; children?: ReactNode }) {
	const [flipped, setFlipped] = useState(false);
	const short = (prefer === 'short') !== flipped;
	const name = short ? shortName : fullName;
	const same = shortName === fullName;
	return (
		<div className="space-y-2">
			<div className="space-y-0.5 rounded-md border border-line bg-surface-2 px-3 py-1.5" role="group" aria-label="DNS record to add">
				<Row label="Type" value="TXT" />
				<Row label="Name" value={name} />
				<Row label="Value" value={value} />
			</div>
			{prefer === 'unknown' && !short && !same ? <p className="text-xs text-ink-2">If your DNS provider adds the domain for you, use only <code className="font-mono">{shortName}</code>.</p> : null}
			{same ? null : (
				<button type="button" className="text-xs text-ink-2 underline underline-offset-4 hover:text-ink-1" onClick={() => setFlipped((f) => !f)}>
					{short ? 'Show full name' : 'Show short name'}
				</button>
			)}
			{children}
		</div>
	);
}
