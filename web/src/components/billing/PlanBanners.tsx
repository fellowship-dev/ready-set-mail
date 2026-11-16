import { Alert, Button, IconButton, toast } from '@ready-set-mail/ui';
import { useMutation } from '@tanstack/react-query';
import { ExternalLink, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { errorMessage } from '../../lib/api';
import { openPortal } from '../../lib/billing';
import { useStripParams } from '../../lib/card-return';
import { usePlan, WORDS } from '../../lib/plan';
import { useHosted } from '../../lib/session';
import { useSearchParams } from 'react-router';

/**
 * What the plan needs the person to know, on every page, one plain sentence and one action each: the result of an add ("Added. $5 a month from today."),
 * a payment that waits for the bank, a payment that did not go through, a renewal that needs the bank, and domains paused after the plan ended.
 * Nothing renders when there is no plan (self-host, billing off, HOSTED_PLAN off) or nothing to say.
 */
export function PlanBanners() {
	const hosted = useHosted();
	const plan = usePlan(hosted);
	const location = useLocation();
	const navigate = useNavigate();
	const flash = (location.state as { planFlash?: { domains: string[]; text: string } } | null)?.planFlash ?? null;
	const portal = useMutation({ mutationFn: openPortal });
	// The one-time notice arrives once in the answer; it stays until it is dismissed.
	const [notice, setNotice] = useState<string | null>(null);
	useEffect(() => { if (plan?.notice) setNotice(plan.notice); }, [plan?.notice]);
	useWorkspaceReturn();
	if (!plan) return null;
	const owner = plan.can_manage;
	const items: React.ReactNode[] = [];

	if (flash) {
		items.push(
			<Alert key="flash" variant="success" title={flash.text}>
				<div className="flex items-start justify-between gap-3">
					<span className="[overflow-wrap:anywhere]">{flash.domains.join(', ')}</span>
					<IconButton label="Dismiss" size="sm" onClick={() => navigate(location.pathname + location.search, { replace: true, state: null })}><X aria-hidden /></IconButton>
				</div>
			</Alert>,
		);
	}
	if (notice) {
		items.push(
			<Alert key="notice" variant="info" title="The domain was not added">
				<div className="flex items-start justify-between gap-3"><span>{WORDS.notCompleted}</span><IconButton label="Dismiss" size="sm" onClick={() => setNotice(null)}><X aria-hidden /></IconButton></div>
			</Alert>,
		);
	}
	if (plan.pending) {
		items.push(
			<Alert key="pending" variant="info" title={WORDS.waitingBank}>
				<span className="[overflow-wrap:anywhere]">{plan.pending.domains.join(', ')} will be added once your bank has confirmed the payment. This updates by itself.</span>
				{owner && plan.pending.action_url ? (
					<div className="pt-2"><Button asChild variant="secondary" size="sm"><a href={plan.pending.action_url} target="_blank" rel="noopener noreferrer">Open the confirmation page<ExternalLink aria-hidden /></a></Button></div>
				) : null}
			</Alert>,
		);
	}
	if (plan.payment_problem) {
		items.push(
			<Alert key="problem" variant="warning" title="Your last payment did not go through">
				<span>{owner ? 'Update your card to add more domains. Your domains keep working.' : 'Ask the workspace owner to update the card. Your domains keep working.'}</span>
				{owner ? <div className="pt-2"><Button size="sm" loading={portal.isPending} onClick={() => portal.mutate()}>Update your card</Button></div> : null}
			</Alert>,
		);
	}
	if (plan.action_required_url && owner) {
		items.push(
			<Alert key="action" variant="warning" title={WORDS.bank}>
				<span>The renewal is waiting for you.</span>
				<div className="pt-2"><Button asChild size="sm"><a href={plan.action_required_url} target="_blank" rel="noopener noreferrer">Confirm the payment<ExternalLink aria-hidden /></a></Button></div>
			</Alert>,
		);
	}
	if (plan.paused_domains > 0) {
		const all = !plan.includes_free_domain;
		items.push(
			<Alert key="paused" variant="info" title={all ? 'Your domains are paused' : plan.paused_domains === 1 ? '1 domain is paused' : `${plan.paused_domains} domains are paused`}>
				<span>{all ? 'You can read and export them; new reports are not processed.' : 'You can read and export them; new reports are not processed.'}{' '}
					{owner ? (plan.resume_by_starting ? `Start pay as you go again to resume ${all ? 'these domains' : 'them'}.` : 'Add a card and start pay as you go to resume them.') : `Ask the workspace owner to start pay as you go again to resume ${all ? 'these domains' : 'them'}.`}</span>
				{owner && plan.paid_available ? <div className="pt-2"><Button asChild size="sm"><Link to="/settings?plan=start">Start pay as you go</Link></Button></div> : null}
			</Alert>,
		);
	}
	if (portal.isError) items.push(<Alert key="err" variant="danger" title="That did not work">{errorMessage(portal.error)}</Alert>);
	if (items.length === 0) return null;
	return <div className="space-y-3">{items}</div>;
}

/** Back from Stripe's page after "Add a card to create a workspace": `workspace=created|canceled|limit`, said once. */
function useWorkspaceReturn() {
	const [params] = useSearchParams();
	const strip = useStripParams();
	const w = params.get('workspace');
	const said = useRef<string | null>(null);
	useEffect(() => {
		if (!w || said.current === w) return;
		said.current = w;
		if (w === 'created') toast({ variant: 'success', title: 'Workspace created', description: 'You are in it now. Its first domain is added from Add domain.' });
		else if (w === 'canceled') toast({ variant: 'info', title: 'No workspace was created', description: 'No card was added, so nothing changed.' });
		else if (w === 'limit') toast({ variant: 'warning', title: 'No workspace was created', description: 'You have reached the limit of workspaces you can own. You have not been charged.' });
		strip('workspace');
	}, [w]); // eslint-disable-line react-hooks/exhaustive-deps
}
