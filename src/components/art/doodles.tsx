import type { SVGProps } from "react";

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

// The logo: two hands meeting, drawn in one line weight.
export function HandshakeMark({ className, label, ...props }: DoodleProps) {
	return (
		<svg viewBox="0 0 120 80" className={cn("shrink-0", className)} {...a11y(label)} {...props}>
			<g className="doodle" style={{ strokeWidth: 3.4 }} transform="rotate(-2 60 40)">
				<path d="M22.6 7.9 C 22.1 15, 21.3 22, 21 29 C 20.6 36, 19.7 42.5, 19.4 49.2" />
				<path d="M28.3 8.4 C 27.5 16, 27 23.5, 26.3 30.5 C 25.7 37.5, 24.9 43.5, 24.1 49" />
				<path d="M27.4 12.9 C 31.5 12.2, 36.5 12.7, 43 11.8 C 47 11.4, 52 12.5, 57.4 12" />
				<path d="M24.3 48.6 C 30 54.5, 40 64.5, 47.4 71.2 C 49.5 74.6, 54.8 75.6, 57.9 72.6" />
				<path d="M67 48.1 C 70 51, 73 54, 76.1 57.1 C 78.7 59.9, 84 59.8, 86.6 56.6 C 89.1 53.6, 88.9 49.4, 86.7 46.9 C 82.4 42.4, 77.9 37.4, 73.6 32.9" />
				<path d="M73.6 32.9 C 71.2 29.8, 66.4 28.4, 62.2 29.6 C 60.2 30.2, 58.6 31.6, 57.2 33.2 L 54.6 36.1 C 52.2 38.8, 47.6 39.2, 44.6 36.6 C 41.5 33.9, 41.4 28.9, 44.2 25.9 C 47.4 22.4, 50.8 18.8, 54.4 15.1 C 58.6 11, 64.8 9.4, 70.4 9.7 C 77.4 10.8, 86.6 14, 93.2 12.6" />
				<path d="M92.2 9.1 C 93 16, 93.6 23.5, 94.4 30.5 C 95 37, 95.7 43, 96.5 48.9" />
				<path d="M97.9 8.2 C 98.6 15, 99.3 22.5, 99.9 29.5 C 100.5 36.5, 101 42.5, 101.7 49.1" />
			</g>
		</svg>
	);
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
