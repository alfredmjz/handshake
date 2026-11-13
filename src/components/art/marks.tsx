import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

type MarkProps = {
	children: ReactNode;
	className?: string;
	// Seconds before the pen starts, so a mark follows what it marks.
	delay?: number;
};

const delayOf = (delay?: number) =>
	delay === undefined ? undefined : ({ "--mark-delay": `${delay}s` } as CSSProperties);

// A loop of ink drawn round the one number that matters; the pen overshoots where it started.
export function Circled({ children, className, delay }: MarkProps) {
	return (
		<span className={cn("relative inline-block", className)}>
			{children}
			<svg
				aria-hidden
				viewBox="0 0 200 80"
				preserveAspectRatio="none"
				className="mark-draw pointer-events-none absolute -inset-x-5 -inset-y-2.5 h-[calc(100%+1.25rem)] w-[calc(100%+2.5rem)] overflow-visible"
				style={delayOf(delay)}
			>
				<path
					className="doodle"
					style={{ strokeWidth: 2.2 }}
					vectorEffect="non-scaling-stroke"
					d="M24 46 C 18 20, 68 6, 118 8 C 166 10, 193 26, 187 46 C 181 67, 122 76, 80 72 C 38 68, 9 56, 19 35 C 26 21, 46 13, 66 11"
				/>
			</svg>
		</span>
	);
}

// A quick wavy line under a word, as you'd underline it in a notebook.
export function Underlined({
	children,
	className,
	delay,
	tone = "owe-mark",
}: MarkProps & { tone?: "owe-mark" | "waiting" }) {
	return (
		<span className={cn("relative inline-block", className)}>
			{children}
			<svg
				aria-hidden
				viewBox="0 0 200 12"
				preserveAspectRatio="none"
				className="mark-draw pointer-events-none absolute inset-x-0 -bottom-[0.14em] h-[0.2em] w-full overflow-visible [--mark-length:360]"
				style={delayOf(delay)}
			>
				<path
					className="doodle"
					style={{ strokeWidth: 2.6, stroke: `hsl(var(--${tone}))` }}
					vectorEffect="non-scaling-stroke"
					d="M2 7 C 28 2, 52 11, 82 6 S 132 3, 162 7 S 190 8, 198 4"
				/>
			</svg>
		</span>
	);
}

type MarkerTone = "food" | "drinks" | "stay" | "travel" | "groceries" | "fun";

// Things you'd doodle in a sketchbook's margin while working out who owes what.
const DOODLES = {
	star: "M12 2.5 L14.6 8.7 L21.4 9.3 L16.2 13.7 L17.8 20.4 L12 16.9 L6.2 20.6 L7.9 13.8 L2.6 9.4 L9.5 8.8 Z",
	coin: "M12 3 C 17.2 2.8, 21.2 6.8, 21 12 C 20.8 17.3, 16.9 21.2, 12 21 C 6.8 20.9, 2.9 17, 3 12 C 3.1 7, 6.9 3.1, 12 3 M12 6.8 L 12 17.2 M14.8 9.4 C 13.8 8, 10 8.1, 9.7 10.2 C 9.4 12.3, 14.7 11.8, 14.5 14.1 C 14.3 16.2, 10.2 16.2, 9.2 14.6",
	spiral:
		"M12 12 C 12 10.5, 14 10.5, 14 12.2 C 14 14.5, 10.5 14.8, 10 12 C 9.4 8.6, 14.6 7.4, 16.4 11 C 18.4 15.4, 12.6 19, 8.6 16.4 C 4.4 13.6, 6.4 6.4, 12 5.6",
	plus: "M12 5 C 11.8 9, 12.2 15, 12 19 M5 12 C 9 11.8, 15 12.2, 19 12",
	zigzag: "M2.5 14 L6.5 9 L10.5 14 L14.5 9 L18.5 14 L21.5 10",
	heart:
		"M12 20 C 5 15, 3 10.5, 5.5 7.5 C 7.6 5, 10.8 5.8, 12 8.4 C 13.2 5.8, 16.4 5, 18.5 7.5 C 21 10.5, 19 15, 12 20",
	arrow: "M3 16 C 8 6, 15 6, 14 12 C 13.4 15.6, 9.6 14, 12 10.6 C 14 8, 18 8.6, 21 10 M17.6 7 L 21 10 L 18 13",
	split: "M4 6 L 20 18 M4 18 L 20 6 M12 3 L 12 21",
} as const;

type Placed = { doodle: keyof typeof DOODLES; top: string; x: string; size: number; turn: number; tint?: MarkerTone };

const LEFT: Placed[] = [
	{ doodle: "star", top: "14%", x: "34%", size: 34, turn: -12, tint: "drinks" },
	{ doodle: "arrow", top: "33%", x: "58%", size: 46, turn: 8 },
	{ doodle: "coin", top: "52%", x: "22%", size: 40, turn: -6, tint: "groceries" },
	{ doodle: "zigzag", top: "70%", x: "50%", size: 44, turn: 4 },
	{ doodle: "plus", top: "86%", x: "30%", size: 26, turn: 14 },
];
const RIGHT: Placed[] = [
	{ doodle: "spiral", top: "18%", x: "40%", size: 40, turn: 10 },
	{ doodle: "heart", top: "38%", x: "64%", size: 32, turn: -10, tint: "fun" },
	{ doodle: "split", top: "57%", x: "30%", size: 30, turn: 6 },
	{ doodle: "coin", top: "74%", x: "58%", size: 36, turn: 12, tint: "travel" },
	{ doodle: "star", top: "90%", x: "36%", size: 24, turn: -8 },
];

function Margin({ side, items }: { side: "left" | "right"; items: Placed[] }) {
	return (
		<div
			aria-hidden
			className={cn(
				"pointer-events-none fixed inset-y-0 hidden w-[calc((100vw-72rem)/2)] min-[1320px]:block",
				side === "left" ? "left-0" : "right-0"
			)}
		>
			{items.map((item, i) => (
				<svg
					key={i}
					viewBox="0 0 24 24"
					width={item.size}
					height={item.size}
					className="absolute overflow-visible"
					style={{ top: item.top, left: item.x, transform: `rotate(${item.turn}deg)` }}
				>
					{item.tint && <circle cx="13" cy="13" r="9" fill={`hsl(var(--category-${item.tint}) / 0.55)`} />}
					<path className="doodle" style={{ strokeWidth: 1.5, opacity: 0.55 }} d={DOODLES[item.doodle]} />
				</svg>
			))}
		</div>
	);
}

// Doodles in the page's side margins, on screens wide enough to have margins.
export function MarginDoodles() {
	return (
		<>
			<Margin side="left" items={LEFT} />
			<Margin side="right" items={RIGHT} />
		</>
	);
}
