import { Alert, Card, CardContent, Skeleton, Switch } from '@ready-set-mail/ui';
import { Section } from '../../components/states';
import { errorMessage } from '../../lib/api';
import { useEmailPreferences, useSetEmailPreference, type EmailKind } from '../../lib/email-preferences';
import { useHosted } from '../../lib/session';

const CHOICES: Array<{ kind: EmailKind; label: string; description: string }> = [
	{ kind: 'summary', label: 'Weekly summary', description: 'On Mondays: what last week\'s DMARC reports said about this workspace\'s domains, and the one thing to look at, if any.' },
	{ kind: 'tips', label: 'Tips about your domains', description: 'Off until you turn it on. Then, now and then, and only when it is true for one of your domains: a service that needs SPF or DKIM, or that every message passed for two weeks, so the next DMARC step is ready.' },
];

/**
 * Settings -> Email: which optional emails this person gets for the open workspace. Hosted only. Owners and admins; a member is offered neither
 * (the first-report and "records live" emails are not optional and are not listed). The choice is effective on the next send.
 */
export function EmailSection() {
	const hosted = useHosted();
	const q = useEmailPreferences();
	const set = useSetEmailPreference();
	if (!hosted || q.isError) return null;
	const prefs = q.data;
	if (prefs && !prefs.summary.offered) return null;

	return (
		<Section title="Email" description="Which optional emails you get from Ready Set Mail for this workspace. Your choice applies to you only.">
			{!prefs ? (
				<Skeleton className="h-24 w-full" />
			) : (
				<Card>
					<CardContent className="py-2">
						<ul className="divide-y divide-line">
							{CHOICES.filter((c) => prefs[c.kind].offered).map((c) => (
								<li key={c.kind} className="flex items-start justify-between gap-4 py-3">
									<div className="min-w-0">
										<p id={`email-${c.kind}-label`} className="text-sm font-medium">{c.label}</p>
										<p id={`email-${c.kind}-description`} className="text-sm text-ink-2">{c.description}</p>
									</div>
									<Switch
										checked={prefs[c.kind].enabled}
										disabled={set.isPending}
										aria-labelledby={`email-${c.kind}-label`}
										aria-describedby={`email-${c.kind}-description`}
										onCheckedChange={(enabled) => set.mutate({ kind: c.kind, enabled })}
									/>
								</li>
							))}
						</ul>
						{set.isError ? <Alert variant="danger" title="Could not save that"><p>{errorMessage(set.error)}</p></Alert> : null}
					</CardContent>
				</Card>
			)}
		</Section>
	);
}
