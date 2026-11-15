import { Button } from '@ready-set-mail/ui';
import { useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../../components/domain/ConfirmDialog';
import { errorMessage } from '../../lib/api';

/** A small danger button whose action runs only after a confirmation dialog. The error stays in the dialog. */
export function ConfirmButton({
	label,
	accessibleName,
	title,
	description,
	confirmLabel,
	disabled,
	onConfirm,
}: {
	label: string;
	/** A longer name for screen readers that starts with the visible label ("Revoke Nightly check"). */
	accessibleName?: string;
	title: ReactNode;
	description: ReactNode;
	confirmLabel: string;
	disabled?: boolean;
	onConfirm: () => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function confirm() {
		setBusy(true);
		setError(null);
		try {
			await onConfirm();
			setOpen(false);
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<Button size="sm" variant="danger" aria-label={accessibleName} disabled={disabled} onClick={() => setOpen(true)}>
				{label}
			</Button>
			<ConfirmDialog
				open={open}
				onOpenChange={(o) => {
					setOpen(o);
					if (!o) setError(null);
				}}
				title={title}
				description={description}
				confirmLabel={confirmLabel}
				variant="danger"
				busy={busy}
				error={error}
				onConfirm={() => void confirm()}
			/>
		</>
	);
}
