import type { SVGProps } from "react";

import { HandsGlyph } from "@/components/art/hands-glyph";
import { cn } from "@/lib/utils";

type DoodleProps = SVGProps<SVGSVGElement> & { label?: string };

function a11y(label?: string) {
	return label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
}

// A quick hand-drawn tick: settled, picked, done.
export function CheckDoodle({ className, label, ...props }: DoodleProps) {
	return (
		<svg viewBox="0 0 24 24" className={cn("shrink-0", className)} {...a11y(label)} {...props}>
			<path
				className="doodle"
				style={{ strokeWidth: 2.8 }}
				d="M4.5 12.8 C 6.5 14.8, 8.4 16.6, 10 18.2 C 13 13.6, 16.4 9.6, 20 6"
			/>
		</svg>
	);
}

// A hand-drawn bell; `ringing` adds the two little swings either side when there's something new.
export function BellDoodle({ className, label, ringing = false, ...props }: DoodleProps & { ringing?: boolean }) {
	return (
		<svg viewBox="0 0 24 24" className={cn("shrink-0 overflow-visible", className)} {...a11y(label)} {...props}>
			<g className="doodle" style={{ strokeWidth: 1.9 }} transform={ringing ? "rotate(-8 12 4)" : undefined}>
				<path d="M12.1 3.2 L 12 5.1" />
				<path d="M6.6 16.4 C 7.6 15.1, 7.8 13.5, 7.7 11.5 L 7.7 10.4 C 7.6 7.3, 9.5 5.1, 12.1 5.1 C 14.7 5.2, 16.5 7.4, 16.4 10.5 L 16.4 11.6 C 16.4 13.6, 16.7 15.2, 17.8 16.5" />
				<path d="M5.3 16.7 C 9.6 16.2, 14.3 16.3, 18.8 16.9" />
				<path d="M10.1 19.1 C 10.7 20.5, 13.3 20.6, 14 19" />
			</g>
			{ringing && (
				<g className="doodle" style={{ strokeWidth: 1.6 }}>
					<path d="M3.9 9.6 C 3.3 8, 3.6 6.4, 4.7 5.2" />
					<path d="M20.1 9.6 C 20.7 8, 20.4 6.4, 19.3 5.2" />
				</g>
			)}
		</svg>
	);
}

// The logo: the two hands clasped, cuffs and all, in one line weight.
export function HandshakeMark({ className, label }: { className?: string; label?: string }) {
	return <HandsGlyph pose="clasped" strokeWidth={4.4} label={label} className={cn("shrink-0", className)} />;
}

// A torn receipt, the thing every group passes around.
export function ReceiptDoodle({ className, label, ...props }: DoodleProps) {
	return (
		<svg viewBox="0 0 60 76" className={cn("shrink-0", className)} {...a11y(label)} {...props}>
			<g className="doodle">
				<path
					style={{ fill: "hsl(var(--paper))", strokeWidth: 2.2 }}
					d="M6 4 C 22 4.6, 38 3.6, 54 4.4 L 54 66 L 48 72 L 42 66 L 36 72 L 30 66 L 24 72 L 18 66 L 12 72 L 6 66 Z"
				/>
				<path
					style={{ strokeWidth: 1.8, opacity: 0.45 }}
					d="M14 18 L 46 18 M14 27 L 38 27 M14 35 L 42 35 M14 43 L 33 43"
				/>
				<path style={{ strokeWidth: 2.4 }} d="M14 54 C 24 53.4, 36 54.6, 46 53.8" />
			</g>
		</svg>
	);
}

// A loopy arrow from one person to another, for a payment to make.
export function SquiggleArrow({ className, variant = "up", ...props }: DoodleProps & { variant?: "up" | "down" }) {
	const d =
		variant === "up"
			? "M2 30 C 30 12, 52 46, 82 30 C 92 24, 100 18, 104 25 C 108 33, 96 37, 94 30 C 92 22, 122 14, 150 30 C 168 40, 184 26, 197 28"
			: "M2 26 C 28 40, 54 14, 84 28 C 94 33, 102 38, 106 31 C 110 23, 98 20, 96 27 C 94 34, 124 42, 152 27 C 170 18, 184 30, 197 28";
	return (
		<svg viewBox="0 0 200 56" preserveAspectRatio="none" aria-hidden className={cn("shrink-0", className)} {...props}>
			<g className="doodle" style={{ strokeWidth: 1.8 }}>
				<path d={d} />
				<path d="M189 22.5 L 197 28 L 188.5 33" />
			</g>
		</svg>
	);
}
