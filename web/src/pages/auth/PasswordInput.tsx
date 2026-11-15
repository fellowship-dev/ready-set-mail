import { Input, type InputProps } from '@ready-set-mail/ui';
import { useState } from 'react';

/** A password typed once, with a Show/Hide toggle instead of a second "confirm" field. */
export function PasswordInput({ id, ...props }: Omit<InputProps, 'type'> & { id: string }) {
	const [shown, setShown] = useState(false);
	return (
		<div className="relative">
			<Input id={id} type={shown ? 'text' : 'password'} className="pr-16" spellCheck={false} autoCapitalize="none" {...props} />
			<button
				type="button"
				className="absolute inset-y-0 right-0 min-w-14 rounded-r-md px-3 text-sm font-medium text-brand-ink underline-offset-4 hover:underline"
				aria-controls={id}
				aria-pressed={shown}
				aria-label={shown ? 'Hide password' : 'Show password'}
				onClick={() => setShown((s) => !s)}
			>
				{shown ? 'Hide' : 'Show'}
			</button>
		</div>
	);
}
