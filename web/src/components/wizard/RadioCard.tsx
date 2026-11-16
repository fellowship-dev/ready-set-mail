import type { ReactNode } from 'react';

/** A native radio dressed as a selectable card; the checked state is a thicker border plus the filled radio, not colour alone. */
export function RadioCard({
	name,
	value,
	checked,
	onChange,
	title,
	badge,
	children,
	disabled,
	compact = false,
}: {
	name: string;
	value: string;
	checked: boolean;
	onChange: (value: string) => void;
	title: ReactNode;
	badge?: ReactNode;
	children?: ReactNode;
	disabled?: boolean;
	/** Less padding: a short list of short choices that must fit a phone's first screen. */
	compact?: boolean;
}) {
	return (
		<label className={`flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface-1 has-checked:border-2 has-checked:border-brand has-checked:bg-brand-subtle has-disabled:cursor-not-allowed has-disabled:opacity-60 ${compact ? 'p-3 has-checked:p-[calc(0.75rem-1px)]' : 'p-4 has-checked:p-[calc(1rem-1px)]'}`}>
			<input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={() => onChange(value)} className="mt-0.5 size-5 shrink-0" />
			<span className="min-w-0 space-y-1">
				<span className="flex flex-wrap items-center gap-2 font-semibold text-ink-1">
					{title}
					{badge}
				</span>
				{children ? <span className="block text-sm text-ink-2">{children}</span> : null}
			</span>
		</label>
	);
}
