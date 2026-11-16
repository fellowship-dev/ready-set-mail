import { Alert, Button, IconButton, toast } from '@ready-set-mail/ui';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useStripParams } from '../../lib/card-return';
import { usePlan, WORDS } from '../../lib/plan';
import { useHosted } from '../../lib/session';
import { useSearchParams } from 'react-router';
import { PlanAlert, planAlertKind, sayingItsOwnPlanAlert } from './PlanAlerts';

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
	// A payment that needs the person: one alert, said where it is acted on (the Add domain confirm and Settings → Billing say it in their own place).
	if (planAlertKind(plan) && !sayingItsOwnPlanAlert(location.pathname)) items.push(<PlanAlert key="payment" plan={plan} />);
	if (plan.paused_domains > 0 && !(plan.lapsed && location.pathname.startsWith('/settings'))) {
		const all = !plan.includes_free_domain;
		items.push(
			<Alert key="paused" variant="info" title={all ? 'Your domains are paused' : plan.paused_domains === 1 ? '1 domain is paused' : `${plan.paused_domains} domains are paused`}>
				<span>{all ? 'You can read and export them; new reports are not processed.' : 'You can read and export them; new reports are not processed.'}{' '}
					{owner ? (plan.resume_by_starting ? `Start pay as you go again to resume ${all ? 'these domains' : 'them'}.` : 'Add a card and start pay as you go to resume them.') : `Ask the workspace owner to start pay as you go again to resume ${all ? 'these domains' : 'them'}.`}</span>
				{owner && plan.paid_available ? <div className="pt-2"><Button asChild size="sm"><Link to="/settings?plan=start">Start pay as you go</Link></Button></div> : null}
			</Alert>,
		);
	}
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
