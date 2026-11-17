import { StatusDot } from '@ready-set-mail/ui';

/** How reports reach a name that has no connection of its own (`reachWords`): the one statement the panel, the setup steps and the domain page show. */
export function ReachStatement({ words }: { words: { headline: string; sentences: string[] } }) {
	return (
		<div className="space-y-1" data-testid="reports-reach">
			<StatusDot status="info" label={words.headline} className="font-semibold" />
			{words.sentences.map((t) => (
				<p key={t} className="text-sm text-ink-2">
					{t}
				</p>
			))}
		</div>
	);
}
