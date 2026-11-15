import { Button } from '@ready-set-mail/ui';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Cloudflare Turnstile, rendered explicitly. Automatic rendering only draws the widgets present when the script first loads,
 * so a form reached by navigating inside the app afterwards (sign-up → "Check your email") never got one. Here the script is
 * loaded once with `render=explicit`, and every form renders, resets and removes its own widget.
 */
const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
	render(
		el: HTMLElement,
		opts: {
			sitekey: string;
			theme?: string;
			size?: string;
			appearance?: string;
			execution?: string;
			callback: (token: string) => void;
			'expired-callback': () => void;
			'error-callback': () => void;
			'before-interactive-callback'?: () => void;
			'after-interactive-callback'?: () => void;
		},
	): string;
	execute(id: string): void;
	reset(id: string): void;
	remove(id: string): void;
}
declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

let loading: Promise<TurnstileApi> | null = null;

/** Tests only: forget a pending load. */
export function __resetTurnstileLoaderForTests(): void {
	loading = null;
}

/** Load the script once (shared by every widget); a failed load can be retried. */
export function loadTurnstile(): Promise<TurnstileApi> {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	if (loading) return loading;
	loading = new Promise<TurnstileApi>((resolve, reject) => {
		const s = document.createElement('script');
		s.src = SRC;
		s.async = true;
		s.dataset.cfTurnstile = '1';
		s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not start')));
		s.onerror = () => reject(new Error('Turnstile could not be loaded'));
		document.head.appendChild(s);
	}).catch((e: unknown) => {
		loading = null; // the next attempt loads it again
		document.querySelectorAll('script[data-cf-turnstile]').forEach((el) => el.remove());
		throw e;
	});
	return loading;
}

export type HumanCheck = {
	/** The form element to place inside the form (null when this instance has no bot check). */
	widget: ReactNode;
	/** The solved, unused token, if any. */
	token: string | null;
	/** True when the form may be submitted: no check configured, or a token is ready (always, when the check runs on submit). */
	ready: boolean;
	/** Call after each submit: a token is single use, so a fresh check starts. */
	reset: () => void;
	/**
	 * `execution: 'execute'` only: run the check now (on the person's submit) and resolve with its token, or null when it did not
	 * pass or could not load. Resolves null at once when this instance has no bot check. If Cloudflare needs a click, the widget
	 * appears under the button (Turnstile's `interaction-only`) and this resolves when it is solved.
	 */
	run: () => Promise<string | null>;
};

/**
 * How the widget shows. `interaction-only` (the default): nothing is drawn unless Cloudflare needs the person to interact, so
 * the form reads fields → button and the check stays out of the way; `flexible` width when it does show.
 */
export interface HumanCheckOptions {
	appearance?: 'always' | 'interaction-only';
	size?: 'normal' | 'compact' | 'flexible';
	/**
	 * `render` (default): the check starts when the widget is drawn, and the form waits for its token.
	 * `execute`: the check starts only when `run()` is called, which is what a form with several steps or a single submit wants
	 * (Cloudflare's "Turnstile in multi-step forms": widget-configurations, `execution`).
	 */
	execution?: 'render' | 'execute';
}

/**
 * One human check for one form. `siteKey` null: the instance has none, and the form needs nothing. The widget is its own
 * component, so it is rendered when the form mounts (also after in-app navigation back to it) and removed when it unmounts;
 * a form that needs the check only for one action renders `widget` only once that action is used.
 */
export function useHumanCheck(siteKey: string | null | undefined, options: HumanCheckOptions = {}): HumanCheck {
	const appearance = options.appearance ?? 'interaction-only';
	const size = options.size ?? 'flexible';
	const execution = options.execution ?? 'render';
	const [token, setToken] = useState<string | null>(null);
	const resetWidget = useRef<(() => void) | null>(null);
	const control = useRef<RunControl>({ execute: null, waiter: null });
	const reset = useCallback(() => {
		setToken(null);
		resetWidget.current?.();
	}, []);
	const tokenRef = useRef<string | null>(null);
	tokenRef.current = token;
	const run = useCallback((): Promise<string | null> => {
		if (tokenRef.current) return Promise.resolve(tokenRef.current);
		return new Promise<string | null>((resolve) => {
			control.current.waiter?.(null); // a run still waiting is superseded
			control.current.waiter = resolve;
			control.current.execute?.(); // not drawn yet: the widget runs it as soon as it is
		});
	}, []);
	if (!siteKey) return { widget: null, token: null, ready: true, reset, run: () => Promise.resolve(null) };
	return {
		widget: <HumanCheckBox siteKey={siteKey} appearance={appearance} size={size} execution={execution} onToken={setToken} resetRef={resetWidget} control={control} hasToken={!!token} />,
		token,
		ready: execution === 'execute' || !!token,
		reset,
		run,
	};
}

/** What `run()` and the widget hand each other: the widget's execute call, and the caller waiting for its token. */
interface RunControl {
	execute: (() => void) | null;
	waiter: ((token: string | null) => void) | null;
}

function HumanCheckBox({ siteKey, appearance, size, execution, onToken, resetRef, control, hasToken }: { siteKey: string; appearance: string; size: string; execution: 'render' | 'execute'; onToken: (t: string | null) => void; resetRef: { current: (() => void) | null }; control: { current: RunControl }; hasToken: boolean }) {
	const box = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<'loading' | 'ready' | 'failed' | 'rejected'>('loading');
	const [interactive, setInteractive] = useState(false);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let gone = false;
		let id: string | null = null;
		setState('loading');
		loadTurnstile().then(
			(api) => {
				if (gone || !box.current) return;
				const widgetId = api.render(box.current, {
					sitekey: siteKey,
					theme: 'auto',
					size,
					appearance,
					execution,
					callback: (t) => {
						setState('ready');
						setInteractive(false);
						onToken(t);
						const waiter = control.current.waiter;
						control.current.waiter = null;
						waiter?.(t);
					},
					'expired-callback': () => {
						onToken(null);
						if (id) api.reset(id);
					},
					'error-callback': () => {
						onToken(null);
						setInteractive(false);
						setState('rejected');
						const waiter = control.current.waiter;
						control.current.waiter = null;
						waiter?.(null);
					},
					'before-interactive-callback': () => setInteractive(true),
					'after-interactive-callback': () => setInteractive(false),
				});
				id = widgetId;
				resetRef.current = () => {
					api.reset(widgetId);
					setState('ready');
				};
				if (execution === 'execute') {
					control.current.execute = () => {
						setState('ready');
						api.execute(widgetId);
					};
					// A run asked for before the script loaded starts now.
					if (control.current.waiter) control.current.execute();
				}
				setState('ready');
			},
			() => {
				if (!gone) setState('failed');
				const waiter = control.current.waiter;
				control.current.waiter = null;
				waiter?.(null);
			},
		);
		return () => {
			gone = true;
			if (id && window.turnstile) window.turnstile.remove(id);
			resetRef.current = null;
			control.current.execute = null;
			onToken(null);
		};
	}, [siteKey, attempt, execution, onToken, resetRef, control]);

	return (
		<div className="space-y-1">
			<div ref={box} data-testid="human-check" />
			{state === 'failed' ? (
				<p className="text-sm text-danger" role="alert">
					The human check could not be loaded. Check your connection, then{' '}
					<Button type="button" variant="link" className="h-auto p-0" onClick={() => setAttempt((n) => n + 1)}>
						try again
					</Button>
					.
				</p>
			) : state === 'rejected' ? (
				<p className="text-sm text-danger" role="alert">
					The human check did not pass.{' '}
					<Button type="button" variant="link" className="h-auto p-0" onClick={() => setAttempt((n) => n + 1)}>
						Try it again
					</Button>
					{' '}or reload the page.
				</p>
			) : execution === 'execute' ? (
				// One plain line, only while Cloudflare is asking for a click.
				interactive ? (
					<p className="text-sm text-ink-2" role="status">
						One more check from Cloudflare, then we continue.
					</p>
				) : null
			) : !hasToken ? (
				<p className="text-xs text-ink-2" aria-live="polite">
					Waiting for the human check…
				</p>
			) : null}
		</div>
	);
}
