import { Card, CardContent } from '@ready-set-mail/ui';
import { useEffect, useId, useRef, type ReactNode } from 'react';

/** The card every wizard step lives in. The heading takes focus on mount so a step change is announced. */
export function StepCard({ title, badge, children, focusHeading = true, compactOnPhone = false }: { title: ReactNode; badge?: ReactNode; children: ReactNode; focusHeading?: boolean; /** Phones: keep the heading for screen readers only and tighten the padding, so the one thing to do stays on the first screen. */ compactOnPhone?: boolean }) {
	const id = useId();
	const ref = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		if (focusHeading) ref.current?.focus({ preventScroll: true });
	}, [focusHeading]);
	return (
		<Card role="region" aria-labelledby={id}>
			<CardContent className={`space-y-4 sm:p-6 [&>p]:max-w-prose${compactOnPhone ? ' max-sm:space-y-2 max-sm:p-3' : ''}`}>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					{badge}
					<h2 id={id} ref={ref} tabIndex={-1} className={`text-xl font-semibold tracking-tight outline-none${compactOnPhone ? ' max-sm:sr-only' : ''}`}>
						{title}
					</h2>
				</div>
				{children}
			</CardContent>
		</Card>
	);
}

/**
 * Two columns from `lg`: explanation and controls left (about a third), records right (about two thirds).
 * One column below `lg`, aside first. Put a StepAside and a StepMain inside; the step footer stays outside, full width.
 */
export function StepColumns({ children }: { children: ReactNode }) {
	return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:items-start lg:gap-8">{children}</div>;
}

export function StepAside({ children }: { children: ReactNode }) {
	return <div className="min-w-0 space-y-4 [&>p]:max-w-prose">{children}</div>;
}

export function StepMain({ children }: { children: ReactNode }) {
	return <div className="min-w-0 space-y-4 [&>p]:max-w-prose">{children}</div>;
}
