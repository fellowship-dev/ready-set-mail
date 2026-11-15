import { Button, cn, toast } from '@ready-set-mail/ui';
import { Copy } from 'lucide-react';
import { useId, type ReactNode } from 'react';

export async function copyToClipboard(value: string) {
	try {
		await navigator.clipboard.writeText(value);
		toast({ title: 'Copied to clipboard', variant: 'success', duration: 2000 });
	} catch {
		toast({ title: 'Could not copy', description: 'Select the text and copy it by hand.', variant: 'warning' });
	}
}

/**
 * A label above a long value (an address, a command) in monospace, wrapped inside its box so it never widens the page,
 * with a Copy button. `copyLabel` names the button for screen readers ("Copy agent address").
 */
export function CopyValue({ label, value, copyLabel, hint, multiline = false }: { label: string; value: string; copyLabel: string; hint?: ReactNode; multiline?: boolean }) {
	const id = useId();
	return (
		<div className="min-w-0 space-y-2">
			<p id={`${id}-label`} className="text-sm font-medium leading-none text-ink-1">
				{label}
			</p>
			<div className="flex min-w-0 items-start gap-2 rounded-md border border-line bg-surface-2 py-1 pl-3 pr-1">
				<code
					id={id}
					aria-labelledby={`${id}-label`}
					className={cn('min-w-0 flex-1 py-1.5 font-mono text-sm text-ink-1 [overflow-wrap:anywhere]', multiline && 'whitespace-pre-wrap')}
				>
					{value}
				</code>
				<Button type="button" size="sm" variant="ghost" aria-label={copyLabel} onClick={() => void copyToClipboard(value)}>
					<Copy aria-hidden />
					Copy
				</Button>
			</div>
			{hint ? <p className="text-sm text-ink-2">{hint}</p> : null}
		</div>
	);
}
