import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FieldHint, Label, Textarea } from '@ready-set-mail/ui';
import { useId, useState } from 'react';
import type { HostedErrorInfo } from '../../lib/hosted';

/** Optional SPF source, then enable. The error stays in the dialog so the form can be fixed. */
export function EnableDialog({
	open,
	onOpenChange,
	busy,
	error,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	busy: boolean;
	error: HostedErrorInfo | null;
	onSubmit: (body: { spf_record?: string }) => void;
}) {
	const spfId = useId();
	const hintId = useId();
	const [spf, setSpf] = useState('');
	const blocked = error?.kind === 'full';
	return (
		<Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
			<DialogContent>
				<form
					className="space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						const record = spf.trim();
						onSubmit(record ? { spf_record: record } : {});
					}}
				>
					<DialogHeader>
						<DialogTitle>Enable hosted records</DialogTitle>
						<DialogDescription>Ready Set Mail will publish your DMARC, SPF and TLS-RPT records. You add pointer records in your DNS once.</DialogDescription>
					</DialogHeader>
					<div className="space-y-1.5">
						<Label htmlFor={spfId}>SPF record (optional)</Label>
						<Textarea id={spfId} value={spf} onChange={(e) => setSpf(e.target.value)} aria-describedby={hintId} aria-invalid={error?.kind === 'input' ? true : undefined} placeholder="v=spf1 include:_spf.google.com -all" />
						<FieldHint id={hintId}>Leave empty to build it from the SPF record your domain publishes now.</FieldHint>
					</div>
					{error ? (
						<Alert variant="danger" title={error.title}>
							{error.message}
						</Alert>
					) : null}
					<DialogFooter>
						<Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
							Cancel
						</Button>
						<Button type="submit" loading={busy} disabled={blocked}>
							{busy ? 'Enabling…' : error?.retryable ? 'Retry' : 'Enable hosted records'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
