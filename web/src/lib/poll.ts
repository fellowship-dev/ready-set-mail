import { useEffect, useRef } from 'react';

/**
 * Waiting for a DNS record to show up in public DNS (spec G1): look every 15 seconds for the first 10 minutes the page is open, then every
 * minute. A tab that is hidden does not look (the next visible tick does), and a look that is still running is never doubled.
 */
export const POLL_FAST_MS = 15_000;
export const POLL_SLOW_MS = 60_000;
export const POLL_FAST_FOR_MS = 10 * 60_000;
export const pollDelay = (elapsedMs: number): number => (elapsedMs < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS);

/** Run `look` on that schedule while `enabled`. A failed look is ignored (the next one tries again). `key` restarts the schedule (another claim, another domain). */
export function useDnsPoll(look: () => Promise<unknown>, enabled: boolean, key: unknown): void {
	const latest = useRef(look);
	latest.current = look;
	useEffect(() => {
		if (!enabled) return;
		const started = Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let running = false;
		let stopped = false;
		const schedule = () => {
			timer = setTimeout(async () => {
				if (!stopped && !running && document.visibilityState !== 'hidden') {
					running = true;
					try {
						await latest.current();
					} catch {
						/* the next look tries again */
					} finally {
						running = false;
					}
				}
				if (!stopped) schedule();
			}, pollDelay(Date.now() - started));
		};
		schedule();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [enabled, key]);
}
