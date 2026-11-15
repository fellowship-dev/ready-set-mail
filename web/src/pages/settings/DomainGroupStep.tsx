import { Badge, Button, Checkbox, controlClasses, cn, Field, Input } from '@ready-set-mail/ui';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { Product, Resource } from './access-model';
import { Step } from './Step';

/** Step 1: create a group (an API "product") and tick the workspace domains in it. Ticking saves at once. */
export function DomainGroupStep({
	groups,
	domains,
	group,
	busy,
	onCreate,
	onChoose,
	onToggle,
}: {
	groups: Product[];
	domains: Resource[];
	group: string;
	busy: boolean;
	onCreate: (name: string) => Promise<boolean>;
	onChoose: (id: string) => void;
	onToggle: (domainId: number, mapped: boolean) => void;
}) {
	const [newName, setNewName] = useState('');
	const current = groups.find((g) => g.id === group);
	async function submit(e: FormEvent) {
		e.preventDefault();
		if (await onCreate(newName)) setNewName('');
	}
	return (
		<Step n={1} title="Group the domains a key may see" help="A group is a named set of your domains, for example one per app or brand. Each key gets domains from one group.">
			<form onSubmit={(e) => void submit(e)} className="grid max-w-xl gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
				<Field id="group-name" label="New group name">
					<Input id="group-name" required maxLength={80} placeholder="Online store" value={newName} onChange={(e) => setNewName(e.target.value)} />
				</Field>
				<Button type="submit" variant="secondary" loading={busy}>
					Create group
				</Button>
			</form>
			{groups.length === 0 ? (
				<p className="text-sm text-ink-2">No groups yet. Name one above, for example after the app or brand whose domains it holds.</p>
			) : (
				<div className="max-w-xl">
					<Field id="access-group" label="Group">
						<select id="access-group" className={cn(controlClasses, 'h-10')} value={group} onChange={(e) => onChoose(e.target.value)}>
							<option value="">Choose a group</option>
							{groups.map((g) => (
								<option key={g.id} value={g.id}>
									{g.name}
								</option>
							))}
						</select>
					</Field>
				</div>
			)}
			{current ? (
				domains.length === 0 ? (
					<div className="space-y-2">
						<p className="text-sm text-ink-2">This workspace has no domains yet. Add one, then come back to put it in a group.</p>
						<Button asChild size="sm" variant="secondary">
							<Link to="/add">Add a domain</Link>
						</Button>
					</div>
				) : (
					<fieldset className="min-w-0 space-y-2">
						<legend className="text-sm font-medium text-ink-1">Domains in {current.name}</legend>
						<p className="text-sm text-ink-2">Ticking a domain saves it to the group. A domain can be in several groups; its reports always cover the whole domain.</p>
						<ul className="divide-y divide-line rounded-lg border border-line">
							{domains.map((d) => {
								const mapped = d.mappedProductIds.includes(group);
								return (
									<li key={d.id}>
										<label className="flex min-w-0 cursor-pointer items-center gap-3 px-4 py-3 text-sm">
											<Checkbox disabled={busy} checked={mapped} onCheckedChange={() => onToggle(d.id, mapped)} />
											<span className="min-w-0 font-mono [overflow-wrap:anywhere]">{d.domain}</span>
											{d.mappedProductIds.some((p) => p !== group) ? (
												<Badge variant="outline" className="ml-auto shrink-0">
													Also in another group
												</Badge>
											) : null}
										</label>
									</li>
								);
							})}
						</ul>
					</fieldset>
				)
			) : null}
		</Step>
	);
}
