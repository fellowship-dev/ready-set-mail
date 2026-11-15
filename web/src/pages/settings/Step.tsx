import type { ReactNode } from 'react';
import { useHeadingTag } from '../../components/states';

/** One numbered step of a short flow: a number disc, a heading at the right level, a line of help and its content. */
export function Step({ n, title, help, children }: { n: number; title: string; help?: ReactNode; children: ReactNode }) {
	const H = useHeadingTag(1);
	return (
		<div className="grid min-w-0 gap-x-3 gap-y-4 sm:grid-cols-[2rem_1fr]">
			<span aria-hidden className="hidden size-8 items-center justify-center rounded-full border border-line-strong text-sm font-semibold text-ink-2 sm:flex">
				{n}
			</span>
			<div className="min-w-0 space-y-4">
				<div className="space-y-1">
					<H className="font-semibold text-ink-1">
						<span className="sm:sr-only">{n}. </span>
						{title}
					</H>
					{help ? <p className="max-w-2xl text-sm text-ink-2">{help}</p> : null}
				</div>
				{children}
			</div>
		</div>
	);
}
