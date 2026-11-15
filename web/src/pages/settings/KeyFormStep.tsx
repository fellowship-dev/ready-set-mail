import { Button, Checkbox, Field, Input } from '@ready-set-mail/ui';
import type { FormEvent, ReactNode } from 'react';
import { KEY_ACTIONS, type Resource } from './access-model';
import { Step } from './Step';

/** Steps 2 and 3: what the new key may do, then the button that creates it. `children` shows the result under the button. */
export function KeyFormStep({
	domains,
	groupChosen,
	name,
	onName,
	selected,
	onSelected,
	allowed,
	onAllowed,
	days,
	onDays,
	validExpiry,
	busy,
	blocked,
	onSubmit,
	children,
}: {
	domains: Resource[];
	groupChosen: boolean;
	name: string;
	onName: (v: string) => void;
	selected: number[];
	onSelected: (f: (s: number[]) => number[]) => void;
	allowed: string[];
	onAllowed: (f: (s: string[]) => string[]) => void;
	days: number;
	onDays: (v: number) => void;
	validExpiry: boolean;
	busy: boolean;
	/** A key is on screen, or one stopped partway: finish with it first. */
	blocked: boolean;
	onSubmit: (e: FormEvent) => void;
	children?: ReactNode;
}) {
	const toggle = <T,>(list: T[], value: T, on: boolean) => (on ? (list.includes(value) ? list : [...list, value]) : list.filter((x) => x !== value));
	return (
		<form onSubmit={onSubmit} className="space-y-8">
			<Step n={2} title="Choose what the key may do">
				<div className="max-w-xl">
					<Field id="key-name" label="Key name" hint="So you can tell keys apart later, for example Nightly DNS check.">
						<Input id="key-name" required maxLength={80} value={name} onChange={(e) => onName(e.target.value)} aria-describedby="key-name-hint" />
					</Field>
				</div>
				<fieldset className="min-w-0 space-y-2">
					<legend className="text-sm font-medium text-ink-1">Domains this key may see</legend>
					{domains.length === 0 ? (
						<p className="text-sm text-ink-2">{groupChosen ? 'Tick at least one domain in the group in step 1.' : 'Choose a group in step 1 first.'}</p>
					) : (
						<ul className="divide-y divide-line rounded-lg border border-line">
							{domains.map((d) => (
								<li key={d.id}>
									<label className="flex min-w-0 cursor-pointer items-center gap-3 px-4 py-3 text-sm">
										<Checkbox checked={selected.includes(d.id)} onCheckedChange={(c) => onSelected((s) => toggle(s, d.id, c === true))} />
										<span className="min-w-0 font-mono [overflow-wrap:anywhere]">{d.domain}</span>
									</label>
								</li>
							))}
						</ul>
					)}
				</fieldset>
				<fieldset className="min-w-0 space-y-2">
					<legend className="text-sm font-medium text-ink-1">What it may do</legend>
					<ul className="grid gap-2 sm:grid-cols-2">
						{KEY_ACTIONS.map((a) => (
							<li key={a.id} className="min-w-0">
								<label className="flex h-full min-w-0 cursor-pointer items-start gap-3 rounded-lg border border-line px-4 py-3 text-sm">
									<Checkbox className="mt-0.5" checked={allowed.includes(a.id)} onCheckedChange={(c) => onAllowed((s) => toggle(s, a.id, c === true))} aria-labelledby={`action-${a.id.replace(':', '-')}-label`} aria-describedby={`action-${a.id.replace(':', '-')}`} />
									<span className="min-w-0 space-y-0.5">
										<span id={`action-${a.id.replace(':', '-')}-label`} className="block font-medium text-ink-1">
											{a.label}
										</span>
										<span id={`action-${a.id.replace(':', '-')}`} className="block text-ink-2">
											{a.detail}
										</span>
										<code className="block font-mono text-xs text-ink-2">{a.id}</code>
									</span>
								</label>
							</li>
						))}
					</ul>
				</fieldset>
				<div className="max-w-xs">
					<Field id="key-days" label="Expires after (days)" hint="The key and its access stop working then.">
						<Input id="key-days" type="number" required min={1} value={days} onChange={(e) => onDays(Number(e.target.value))} aria-describedby="key-days-hint" />
					</Field>
				</div>
			</Step>
			<Step n={3} title="Create the key" help="The key is shown once, right after you create it. Copy it into the program's secret settings.">
				<div>
					<Button type="submit" loading={busy} disabled={!validExpiry || !groupChosen || !selected.length || !allowed.length || blocked}>
						Create key
					</Button>
				</div>
				{children}
			</Step>
		</form>
	);
}
