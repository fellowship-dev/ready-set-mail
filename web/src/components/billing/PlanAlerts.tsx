import { Alert, Button, toast } from '@ready-set-mail/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { billingKeys, openPortal } from '../../lib/billing';
import { WORDS, type PlanView } from '../../lib/plan';
import { keys } from '../../lib/queries';

/** The page that says the payment alert itself, in its own place: not twice (the Add domain confirm, and Settings → Billing). */
export const sayingItsOwnPlanAlert = (pathname: string): boolean => pathname.startsWith('/add') || pathname.startsWith('/settings');

/** Which of the three payment alerts is showing: one at a time, the one that blocks the person first. */
export type PlanAlertKind = 'pending' | 'renewal' | 'problem';
export function planAlertKind(plan: PlanView): PlanAlertKind | null {
	if (plan.pending) return 'pending';
	if (plan.action_required_url && plan.can_manage) return 'renewal';
	if (plan.payment_problem) return 'problem';
	return null;
}

/**
 * A payment that needs the person: ONE alert, ONE way forward, wording for what is happening. Three cases, never two at once:
 *   pending   the FIRST payment waits for the bank: the domain is not added yet. "Try again" reopens the bank's page, "Cancel" gives the domain up (nothing was charged).
 *   renewal   a renewal needs the bank: "Confirm the payment".
 *   problem   the last payment did not go through: "Update your card" (Stripe's page).
 */
export function PlanAlert({ plan, domains, actionUrl, onCancelled }: { plan: PlanView; domains?: string[]; actionUrl?: string | null; onCancelled?: () => void }) {
	const qc = useQueryClient();
	const owner = plan.can_manage;
	const kind = planAlertKind(plan);
	const portal = useMutation({ mutationFn: openPortal });
	const cancel = useMutation({
		mutationFn: () => api<{ cancelled: true; domains: string[] }>('/api/billing/plan/cancel-pending', { method: 'POST', body: {} }),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: billingKeys.all });
			void qc.invalidateQueries({ queryKey: keys.domains });
			toast({ variant: 'success', title: 'Cancelled', description: 'The domain was not added and you have not been charged.' });
			onCancelled?.();
		},
	});
	if (!kind) return null;
	const failure = portal.error ?? cancel.error;
	let alert: React.ReactNode;
	if (kind === 'pending') {
		const names = domains ?? plan.pending?.domains ?? [];
		const url = actionUrl ?? plan.pending?.action_url ?? null;
		alert = (
			<Alert variant="info" title={WORDS.waitingBank}>
				<span className="[overflow-wrap:anywhere]">
					{names.length > 0 ? `${names.join(', ')} will be added once your bank has confirmed the payment.` : 'Your plan starts once your bank has confirmed the payment.'} This updates by itself.
				</span>
				{owner ? (
					<div className="flex flex-wrap gap-2 pt-2">
						{url ? <Button asChild size="sm"><a href={url} target="_blank" rel="noopener noreferrer">Try again<ExternalLink aria-hidden /></a></Button> : null}
						<Button size="sm" variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel</Button>
					</div>
				) : null}
			</Alert>
		);
	} else if (kind === 'renewal') {
		alert = (
			<Alert variant="warning" title={WORDS.bank}>
				<span>{WORDS.renewalWaiting}</span>
				<div className="pt-2"><Button asChild size="sm"><a href={plan.action_required_url!} target="_blank" rel="noopener noreferrer">Confirm the payment<ExternalLink aria-hidden /></a></Button></div>
			</Alert>
		);
	} else {
		alert = (
			<Alert variant="warning" title="Your last payment did not go through">
				<span>{owner ? 'Update your card to add more domains. Your domains keep working.' : 'Ask the workspace owner to update the card. Your domains keep working.'}</span>
				{owner ? <div className="pt-2"><Button size="sm" loading={portal.isPending} onClick={() => portal.mutate()}><ExternalLink aria-hidden />Update your card</Button></div> : null}
			</Alert>
		);
	}
	return (
		<div className="space-y-3">
			{alert}
			{failure ? <Alert variant="danger" title="That did not work">{errorMessage(failure)}</Alert> : null}
		</div>
	);
}
