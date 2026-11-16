import { Button } from '@ready-set-mail/ui';
import { Link } from 'react-router';
import { StepCard } from './StepCard';

/** A DNS tool that is off for this domain on this deployment: one line, a way back, nothing else. */
export function ToolOff({ title, line, backTo }: { title: string; line: string; backTo: string }) {
	return (
		<StepCard title={title}>
			<p className="text-sm text-ink-2">{line}</p>
			<Button asChild variant="secondary">
				<Link to={backTo}>Back to domain</Link>
			</Button>
		</StepCard>
	);
}
