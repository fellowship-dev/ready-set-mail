import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FieldError, Input } from '@ready-set-mail/ui';
import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert } from '@ready-set-mail/ui';
import { api, ApiError, errorMessage } from '../lib/api';
import { perInterval, type Money } from '../lib/plan';
import { useCfOffer } from '../lib/cloudflare';
import { setupSeenKey } from '../lib/workspace';
import { switchToWorkspace, useCreateWorkspace } from '../lib/workspaces';
import { Field } from '../pages/auth/AuthLayout';
import { PlanLimitNotice, planLimitOf } from './PlanLimitNotice';

/** Name it, create it (you become its owner), and open it. */
export function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const [name, setName] = useState('');
	const create = useCreateWorkspace((w) => {
		// A workspace you just made starts at its own empty state, not at the first-run wizard.
		sessionStorage.setItem(setupSeenKey(w.id), '1');
		setName('');
		onOpenChange(false);
		switchToWorkspace(w.id);
	});

	// Hosted plan: a person who already holds their free domain adds a card first (the workspace is created when Stripe has it).
	const needs = create.error instanceof ApiError && (create.error.body as { code?: string } | undefined)?.code === 'workspace_needs_card'
		? (create.error.body as { paid_available: boolean; help_url: string | null; unit_price: Money | null })
		: null;
	const card = useMutation({
		mutationFn: () => api<{ url: string; workspace_id: string }>('/api/billing/workspace-intents', { method: 'POST', body: { name: name.trim() } }),
		onSuccess: ({ url, workspace_id }) => {
			// Like any workspace you just made, it starts at its own empty state, not at the first-run wizard (this tab keeps the mark across Stripe's page).
			sessionStorage.setItem(setupSeenKey(workspace_id), '1');
			window.location.assign(url);
		},
	});

	function submit(e: FormEvent) {
		e.preventDefault();
		if (name.trim()) create.mutate(name.trim());
	}

	return (
		<Dialog open={open} onOpenChange={(o) => (create.isPending ? undefined : onOpenChange(o))}>
			<DialogContent>
				<form onSubmit={submit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>Create workspace</DialogTitle>
						<WorkspaceDescription />
					</DialogHeader>
					<Field id="workspace-name" label="Workspace name">
						<Input id="workspace-name" required autoFocus maxLength={80} placeholder="Lexgo" value={name} onChange={(e) => setName(e.target.value)} />
					</Field>
					{needs ? (
						<Alert variant="info" title={needs.paid_available ? 'Add a card to create more workspaces' : 'Your free plan includes one workspace'}>
							{needs.paid_available ? (
								<p>{needs.unit_price ? `Each domain in it is ${perInterval(needs.unit_price)}.` : 'Each domain in it is billed monthly.'} Cancel any time.</p>
							) : (
								<p>For more workspaces, talk to us.{needs.help_url?.startsWith('https://') ? <> <a href={needs.help_url} target="_blank" rel="noreferrer">Talk to us</a></> : null}</p>
							)}
						</Alert>
					) : null}
					{card.isError ? <FieldError>{errorMessage(card.error)}</FieldError> : null}
					{create.isError && !planLimitOf(create.error) && !needs ? <FieldError>{errorMessage(create.error)}</FieldError> : null}
					{create.isError && planLimitOf(create.error) ? <PlanLimitNotice limit={planLimitOf(create.error)!} /> : null}
					<DialogFooter>
						<Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						{needs?.paid_available ? (
							<Button type="button" loading={card.isPending} onClick={() => card.mutate()}>
								Add a card to continue
							</Button>
						) : needs ? null : (
							<Button type="submit" loading={create.isPending} disabled={!name.trim()}>
								Create workspace
							</Button>
						)}
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Cloudflare is named only where it can be connected on this instance (mounted with the open dialog, so it asks then). */
function WorkspaceDescription() {
	const { canConnect } = useCfOffer();
	return (
		<DialogDescription>
			A workspace keeps its own {canConnect ? 'domains, reports, members and Cloudflare connections.' : 'domains, reports and members.'} You will be its owner; invite people from its Members page.
		</DialogDescription>
	);
}
