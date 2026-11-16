import { toast } from '@ready-set-mail/ui';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Back from Stripe's page for adding a card: the server appends `card=added|canceled|error` to the route. Say what happened once, in
 * plain words, and take the parameter out of the address (other parameters, like `order`, stay).
 */
/** Remove one search parameter from the address, leaving the others. Always uses the router's latest setter, so two callers in one page do not undo each other. */
export function useStripParams(): (...names: string[]) => void {
	const [, setParams] = useSearchParams();
	const latest = useRef(setParams);
	latest.current = setParams;
	return (...names) => latest.current((prev) => { const next = new URLSearchParams(prev); for (const n of names) next.delete(n); return next; }, { replace: true });
}

/** `strip: false` when the page removes the parameter itself, together with its others in one step (two router updates in one tick undo each other). */
export function useCardReturn(opts: { strip?: boolean; quiet?: boolean } = {}): void {
	const [params] = useSearchParams();
	const strip = useStripParams();
	const card = params.get('card');
	useEffect(() => {
		if (!card) return;
		// `quiet`: the page shows the card itself (the paid-domain confirm), so a toast would only repeat it over the next screen.
		if (card === 'added') { if (!opts.quiet) toast({ variant: 'success', title: 'Card saved', description: 'It will be used for the next payment.' }); }
		else if (card === 'canceled') toast({ variant: 'info', title: 'No card was added', description: 'Nothing was changed.' });
		else if (card === 'error') toast({ variant: 'danger', title: 'We could not confirm the card', description: 'Nothing was charged. Try adding it again.' });
		if (opts.strip !== false) strip('card');
	}, [card]); // eslint-disable-line react-hooks/exhaustive-deps
}
