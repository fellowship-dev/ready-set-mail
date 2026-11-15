import { FieldError } from '@ready-set-mail/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Disclosure, ListSkeleton } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { useWorkspaceId } from '../../lib/session';
import { accessKey, DEFAULT_ACTIONS, type Access, type Credential, type Issued, type Principal, type Product, type Resource } from './access-model';
import { DomainGroupStep } from './DomainGroupStep';
import { ExistingKeys } from './ExistingKeys';
import { IssuedKeyPanel, PartialKeyAlert } from './IssuedKeyPanel';
import { KeyFormStep } from './KeyFormStep';

const DAY = 86400;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Settings → Access keys for scripts and services (self-hosted, owners only). Collapsed by default: most people never
 * need it. Inside, three steps: group the domains a key may see (the API's "products"), choose what the key may do,
 * create the key and copy it once. Below that, the keys that exist, to replace or revoke.
 */
export function AccessKeysSection() {
	const workspace = useWorkspaceId();
	const qc = useQueryClient();
	const access = useQuery({ queryKey: [...accessKey, workspace], queryFn: () => api<Access>('/api/access'), retry: false });
	const resources = useQuery({ queryKey: ['operator-resources', workspace], queryFn: () => api<{ domains: Resource[] }>('/api/resources'), retry: false });

	const [product, setProduct] = useState('');
	const [name, setName] = useState('');
	const [selected, setSelected] = useState<number[]>([]);
	const [allowed, setAllowed] = useState<string[]>(DEFAULT_ACTIONS);
	const [days, setDays] = useState(30);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [partial, setPartial] = useState<{ id: string; name: string } | null>(null);
	const [issued, setIssued] = useState<Issued | null>(null);

	const refresh = async () => {
		await qc.invalidateQueries({ queryKey: accessKey });
		await qc.invalidateQueries({ queryKey: ['operator-resources'] });
	};
	/** Runs one change; its error is shown under the steps, and the lists are reloaded either way. */
	async function run(fn: () => Promise<void>) {
		setBusy(true);
		setError('');
		try {
			await fn();
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setBusy(false);
			await refresh();
		}
	}

	const validExpiry = Number.isSafeInteger(days) && days > 0 && Number.isSafeInteger(nowSeconds() + days * DAY);

	async function createGroup(groupName: string) {
		let created = false;
		await run(async () => {
			const p = await api<Product>('/api/access/products', { method: 'POST', body: { name: groupName.trim() } });
			setProduct(p.id);
			setSelected([]);
			created = true;
		});
		return created;
	}
	function chooseGroup(id: string) {
		setProduct(id);
		setSelected([]);
	}
	async function toggleMapping(id: number, mapped: boolean) {
		await run(async () => {
			await api(`/api/access/products/${product}/domains/${id}`, { method: mapped ? 'DELETE' : 'PUT' });
			setSelected((s) => s.filter((x) => x !== id));
		});
	}
	async function issue(e: FormEvent) {
		e.preventDefault();
		if (!selected.length || !allowed.length || partial || !resources.data) return;
		const domains = resources.data.domains.filter((d) => selected.includes(d.id));
		const keyName = name.trim();
		await run(async () => {
			const p = await api<Principal>('/api/access/principals', { method: 'POST', body: { name: keyName, kind: 'service' } });
			setPartial({ id: p.id, name: keyName });
			const expires_at = nowSeconds() + days * DAY;
			for (const domain of domains) {
				await api('/api/access/grants', { method: 'POST', body: { principal_id: p.id, product_id: product, domain: domain.domain, actions: allowed, expires_at } });
			}
			const credential = await api<{ id: string; key: string }>('/api/access/credentials', { method: 'POST', body: { principal_id: p.id, name: keyName, expires_at } });
			setIssued({ id: credential.id, key: credential.key, actions: allowed, domains });
			setPartial(null);
			setName('');
		});
	}
	async function revoke(type: 'principals' | 'credentials' | 'grants', id: string) {
		await api(`/api/access/${type}/${id}`, { method: 'DELETE' });
		if (type === 'principals' && partial?.id === id) setPartial(null);
		await refresh();
	}
	async function removePartial() {
		if (!partial) return;
		await run(() => revoke('principals', partial.id));
	}
	async function replace(c: Credential, grantedActions: string[], grantedDomains: Resource[]) {
		await run(async () => {
			const next = await api<{ id: string; key: string }>('/api/access/credentials', {
				method: 'POST',
				body: { principal_id: c.principal_id, name: `${c.name} replacement`.slice(0, 80), expires_at: nowSeconds() + days * DAY },
			});
			setIssued({ id: next.id, key: next.key, previousId: c.id, actions: grantedActions, domains: grantedDomains });
		});
	}
	async function acknowledge() {
		await run(async () => {
			if (issued?.previousId) await api(`/api/access/credentials/${issued.previousId}`, { method: 'DELETE' });
			setIssued(null);
		});
	}

	const data = access.data;
	const activeKeys = data
		? data.credentials.filter((c) => c.revoked_at === null && c.expires_at > nowSeconds() && data.principals.some((p) => p.id === c.principal_id && p.disabled_at === null)).length
		: 0;
	const summary =
		activeKeys > 0
			? `${activeKeys} active ${activeKeys === 1 ? 'key' : 'keys'}. For programs that run without a person.`
			: 'Optional. For programs that run without a person, such as a CI job that checks your domains every night.';

	const panel = issued ? <IssuedKeyPanel issued={issued} busy={busy} onAcknowledge={() => void acknowledge()} /> : null;

	return (
		<Disclosure title="Access keys for scripts and services" summary={summary}>
			{access.isPending || resources.isPending ? (
				<ListSkeleton rows={2} label="Loading access keys" />
			) : access.isError || resources.isError ? (
				<FieldError>{errorMessage(access.error || resources.error)}</FieldError>
			) : (
				<div className="space-y-8">
					<p className="max-w-2xl text-sm text-ink-2">
						A key lets a program that runs without a person, such as a CI job, a script or a monitoring worker, read the domains you choose. It can do only what you allow, and it stops working on
						the date you set. You do not need one to use Ready Set Mail or to connect an AI agent.
					</p>
					<DomainGroupStep
						groups={data!.products.filter((p) => !p.archived_at)}
						domains={resources.data.domains}
						group={product}
						busy={busy}
						onCreate={createGroup}
						onChoose={chooseGroup}
						onToggle={(id, mapped) => void toggleMapping(id, mapped)}
					/>
					<KeyFormStep
						domains={resources.data.domains.filter((d) => d.mappedProductIds.includes(product))}
						groupChosen={!!product}
						name={name}
						onName={setName}
						selected={selected}
						onSelected={setSelected}
						allowed={allowed}
						onAllowed={setAllowed}
						days={days}
						onDays={setDays}
						validExpiry={validExpiry}
						busy={busy}
						blocked={!!partial || !!issued}
						onSubmit={(e) => void issue(e)}
					>
						{partial ? <PartialKeyAlert name={partial.name} id={partial.id} busy={busy} onRemove={() => void removePartial()} /> : null}
						{issued && !issued.previousId ? panel : null}
					</KeyFormStep>
					{error ? <FieldError>{error}</FieldError> : null}
					<ExistingKeys
						access={data!}
						domains={resources.data.domains}
						busy={busy}
						canReplace={!issued && validExpiry}
						replacing={issued?.previousId ?? null}
						replacementPanel={issued?.previousId ? panel : null}
						onReplace={(c, actions, domains) => void replace(c, actions, domains)}
						onRevoke={revoke}
					/>
				</div>
			)}
		</Disclosure>
	);
}
