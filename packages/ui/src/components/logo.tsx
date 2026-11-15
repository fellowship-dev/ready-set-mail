import * as React from "react";
import { ICON, LOCKUP, LOGO_COLORS, MARK_PATHS, WORDMARK_PATH, type LockupSurface } from "./logo-svg.js";

export interface LogoMarkProps extends React.SVGAttributes<SVGSVGElement> {
	/** Accessible name. Leave undefined when the mark sits next to the product name (decorative). */
	title?: string;
}

const Mark = ({ transform }: { transform: string }) => (
	<g transform={transform}>
		<path fill={LOGO_COLORS.blue} d={MARK_PATHS.body} />
		<path fill={LOGO_COLORS.red} d={MARK_PATHS.flag} />
	</g>
);

const a11y = (title: string | undefined) => ({ role: title ? "img" : undefined, "aria-hidden": title ? undefined : true, "aria-label": title });

/**
 * Ready Set Mail icon: the blue mailbox with its raised red flag (web/public/brand/svg/icon.svg, viewBox 0 0 414 414, the
 * pack's clear space included). For places where only a mark fits: the collapsed sidebar, avatar-size uses. Transparent and
 * self-coloured; never recolour it. Square: size it with one dimension (`size-8`). Next to the product name, prefer
 * `LogoLockup`; at 16 px use the favicon set instead.
 */
export const LogoMark = React.forwardRef<SVGSVGElement, LogoMarkProps>(({ title, ...props }, ref) => (
	<svg ref={ref} viewBox={ICON.viewBox} {...a11y(title)} {...props}>
		<Mark transform={ICON.markTransform} />
	</svg>
));
LogoMark.displayName = "LogoMark";

export interface LogoLockupProps extends React.SVGAttributes<SVGSVGElement> {
	/** Accessible name; defaults to the product name. With `aria-hidden` (a parent already carries the name) it has none. */
	title?: string;
	/**
	 * `auto` (default) follows the theme: the navy wordmark of lockup.svg on light surfaces and the white wordmark of
	 * lockup-dark.svg on dark ones (the `--logo-wordmark` token). `light` / `dark` pin one of the two files.
	 */
	surface?: LockupSurface | "auto";
}

/**
 * Ready Set Mail lockup: the mark plus the lowercase "readysetmail" wordmark (web/public/brand/svg/lockup.svg and
 * lockup-dark.svg, viewBox 0 0 1526 347, about 4.4:1, clear space included). Use it wherever the product name and mark
 * appear together and there is width for it. Size it by height (`h-8 w-auto`); it is an image of the name, so it carries the
 * accessible name "Ready Set Mail" unless told otherwise.
 */
export const LogoLockup = React.forwardRef<SVGSVGElement, LogoLockupProps>(({ title = "Ready Set Mail", surface = "auto", ...props }, ref) => {
	const fill = surface === "auto" ? "var(--logo-wordmark)" : surface === "dark" ? LOGO_COLORS.white : LOGO_COLORS.navy;
	const hidden = props["aria-hidden"] === true || props["aria-hidden"] === "true";
	return (
		<svg ref={ref} viewBox={LOCKUP.viewBox} {...a11y(hidden ? undefined : title)} {...props}>
			<Mark transform={LOCKUP.markTransform} />
			<path fill={fill} transform={LOCKUP.wordmarkTransform} d={WORDMARK_PATH} />
		</svg>
	);
});
LogoLockup.displayName = "LogoLockup";
