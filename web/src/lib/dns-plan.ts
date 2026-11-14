/** The one-click Cloudflare onboarding API: what each step would write, performing a step, the first DNS read. */
import { api, ApiError } from './api';

export interface PlanWrite {
	id: string;
	domain: string;
	zone: string;
	/** 'TXT' | 'MX' | … or 'EMAIL_ROUTING' for a routing rule (its `content` is the sentence). */
	type: string;
	name: string;
	content: string;
	priority?: number;
	action: 'create' | 'update' | 'delete' | 'rule' | 'none';
	before: string | null;
	reason: string;
}
export type PlanStepKey = 'dmarc' | 'reports_mailbox';
export interface PlanStep {
	key: PlanStepKey;
	writes: PlanWrite[];
	satisfied: boolean;
}
export interface NotWritten {
	domain?: string;
	what: string;
	reason: string;
	/** A hash route such as `#/domains/7/setup`. */
	link?: string;
}
export interface DnsPlan {
	plan_id: string;
	steps: PlanStep[];
	not_written: NotWritten[];
}
export interface ApplyWriteResult {
	id: string;
	ok: boolean;
	error?: string;
	code?: string;
}
export type ApplyResult = { kind: 'ok'; results: ApplyWriteResult[] } | { kind: 'plan_changed'; plan: DnsPlan };

export const fetchPlan = (domainIds: number[]) =>
	api<DnsPlan>('/api/onboarding/dns-plan', { method: 'POST', body: { domain_ids: domainIds } });

export async function applyStep(domainIds: number[], step: PlanStepKey, planId: string): Promise<ApplyResult> {
	try {
		const r = await api<{ results: ApplyWriteResult[] }>('/api/onboarding/dns-apply', {
			method: 'POST',
			body: { domain_ids: domainIds, step, plan_id: planId },
		});
		return { kind: 'ok', results: r.results };
	} catch (e) {
		const body = e instanceof ApiError ? (e.body as { code?: string; plan?: DnsPlan } | undefined) : undefined;
		if (e instanceof ApiError && e.status === 409 && body?.code === 'plan_changed' && body.plan)
			return { kind: 'plan_changed', plan: body.plan };
		throw e;
	}
}

export const firstCheck = (domainIds: number[]) =>
	api<{ results: { domain_id: number; stored: boolean }[] }>('/api/onboarding/first-check', {
		method: 'POST',
		body: { domain_ids: domainIds },
	});

export type WizardPatch = Partial<Record<'domain' | 'spf' | 'dkim' | 'dmarc' | 'routing', 'not_started' | 'complete' | 'skipped'>>;

/** Records per-domain wizard progress. Best effort: progress marks never block the flow. */
export const markWizardState = (domainId: number, patch: WizardPatch): Promise<void> =>
	api(`/api/domains/${domainId}/wizard-state`, { method: 'PUT', body: patch }).then(
		() => undefined,
		() => undefined,
	);

/** Writes that still need doing (everything but 'none'). */
export const pendingWrites = (writes: PlanWrite[]) => writes.filter((w) => w.action !== 'none');
