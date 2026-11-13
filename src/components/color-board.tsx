import { useRef, type KeyboardEvent, type PointerEvent } from "react";

import { coverHsl, coverKey, HUES, hueOf, parseCover, SHADES, type CoverKey } from "@/lib/cover-colors";
import { cn } from "@/lib/utils";

// The name a hue goes by, for the labels across the top and for screen readers.
function hueName(deg: number) {
	if (deg < 18 || deg >= 340) return "Red";
	if (deg < 42) return "Orange";
	if (deg < 76) return "Yellow";
	if (deg < 150) return "Green";
	if (deg < 190) return "Teal";
	if (deg < 250) return "Blue";
	if (deg < 290) return "Violet";
	return "Pink";
}
const SHADE_NAMES = ["Pale", "Light", "Mid", "Strong", "Deep"];
// Down the side, as GitHub labels every other weekday: enough to say which way it goes.
const SHADE_LABELS = ["Pale", "", "Mid", "", "Deep"];

const COLUMNS = Array.from({ length: HUES }, (_, hue) => hue);
const ROWS = Array.from({ length: SHADES }, (_, shade) => shade);
// A label above every third column, named for the hue there, the way a contribution graph marks its months:
// spaced so they never run into each other.
const HUE_LABELS = COLUMNS.map((hue) => (hue % 3 === 0 ? hueName(hueOf(hue)) : ""));

type ColorBoardProps = {
	value: CoverKey | null;
	// The colour the group has when nothing is chosen, marked on the board.
	fallback: CoverKey;
	onChange: (value: CoverKey | null) => void;
	// Offer going back to the default; off where a colour is always picked, as when starting a group.
	allowDefault?: boolean;
	className?: string;
};

// The colour board, laid out like a contribution graph: hue across, from red round to pink; shade down, from
// pale to deep. Press and drag across it to sweep through the colours, or click one; arrow keys walk it; the legend
// under it shows the chosen hue's five shades.
export function ColorBoard({ value, fallback, onChange, allowDefault = true, className }: ColorBoardProps) {
	const current = value ?? fallback;
	const at = parseCover(current)!;
	const board = useRef<HTMLDivElement>(null);

	const dragging = useRef(false);
	const last = useRef<string | null>(null);

	// The cell nearest the pointer, so a drag that strays past the edge or into a gap still lands on one.
	const cellAt = (x: number, y: number) => {
		let best: HTMLButtonElement | null = null,
			bestDistance = Infinity;
		for (const cell of board.current?.querySelectorAll<HTMLButtonElement>("[data-key]") ?? []) {
			const r = cell.getBoundingClientRect();
			const dx = Math.max(r.left - x, 0, x - r.right),
				dy = Math.max(r.top - y, 0, y - r.bottom);
			const distance = dx * dx + dy * dy;
			if (distance < bestDistance) {
				best = cell;
				bestDistance = distance;
			}
		}
		return best;
	};
	const pick = (event: PointerEvent) => {
		const cell = cellAt(event.clientX, event.clientY);
		const key = cell?.dataset.key;
		if (!cell || !key || key === last.current) return;
		last.current = key;
		onChange(key as CoverKey);
		cell.focus({ preventScroll: true });
	};
	const grab = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		dragging.current = true;
		last.current = null;
		event.currentTarget.setPointerCapture(event.pointerId);
		pick(event);
	};
	const sweep = (event: PointerEvent) => {
		if (dragging.current) pick(event);
	};
	const drop = () => {
		dragging.current = false;
	};

	const move = (event: KeyboardEvent) => {
		const step = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[event.key];
		if (!step) return;
		event.preventDefault();
		const hue = (at.hue + step[0] + HUES) % HUES,
			shade = Math.min(SHADES - 1, Math.max(0, at.shade + step[1]));
		const next = coverKey(hue, shade);
		onChange(next);
		board.current?.querySelector<HTMLButtonElement>(`[data-key="${next}"]`)?.focus();
	};

	return (
		<div className={cn("flex flex-col gap-control", className)}>
			<div
				ref={board}
				role="radiogroup"
				aria-label="Cover colour"
				onKeyDown={move}
				onPointerDown={grab}
				onPointerMove={sweep}
				onPointerUp={drop}
				onPointerCancel={drop}
				// Dragging across the board picks colours, so it doesn't scroll the page under a finger.
				className="grid cursor-crosshair touch-none select-none grid-cols-[auto_repeat(18,minmax(0,1fr))] items-center gap-x-[3px] gap-y-[3px]"
			>
				<span />
				{HUE_LABELS.map((label, hue) => (
					<span key={hue} aria-hidden className="type-micro relative h-4 whitespace-nowrap text-muted-foreground">
						<span className="absolute left-0 top-0">{label}</span>
					</span>
				))}
				{ROWS.map((shade) => (
					<Row key={shade} shade={shade} current={current} chosen={value} fallback={fallback} onChange={onChange} />
				))}
			</div>
			<div className="flex items-center justify-between gap-stack">
				{allowDefault ? (
					<button
						type="button"
						onClick={() => onChange(null)}
						className={cn(
							"type-label underline-offset-4 hover:underline",
							value === null ? "font-semibold text-foreground" : "text-muted-foreground"
						)}
					>
						{value === null ? "Default colour" : "Use the default"}
					</button>
				) : (
					<span />
				)}
				<span className="type-micro flex items-center gap-1.5 text-muted-foreground" aria-hidden>
					Pale
					{ROWS.map((shade) => (
						<span
							key={shade}
							className="size-2.5 rounded-[3px]"
							style={{ background: `hsl(${coverHsl(coverKey(at.hue, shade))})` }}
						/>
					))}
					Deep
				</span>
			</div>
		</div>
	);
}

function Row({
	shade,
	current,
	chosen,
	fallback,
	onChange,
}: {
	shade: number;
	current: CoverKey;
	chosen: CoverKey | null;
	fallback: CoverKey;
	onChange: (value: CoverKey) => void;
}) {
	return (
		<>
			<span aria-hidden className="type-micro pr-1.5 text-muted-foreground">
				{SHADE_LABELS[shade]}
			</span>
			{COLUMNS.map((hue) => {
				const key = coverKey(hue, shade);
				const on = key === current;
				return (
					<button
						key={key}
						type="button"
						role="radio"
						data-key={key}
						aria-checked={on}
						aria-label={`${hueName(hueOf(hue))}, ${SHADE_NAMES[shade].toLowerCase()}${
							key === fallback && chosen === null ? " (default)" : ""
						}`}
						tabIndex={on ? 0 : -1}
						onClick={() => onChange(key)}
						className={cn(
							"aspect-square w-full max-w-5 rounded-[3px] outline-none transition-transform duration-quick ease-out hover:scale-125 focus-visible:ring-2 focus-visible:ring-ring",
							on && "scale-110 ring-2 ring-ink ring-offset-1 ring-offset-paper"
						)}
						style={{ background: `hsl(${coverHsl(key)})` }}
					/>
				);
			})}
		</>
	);
}
