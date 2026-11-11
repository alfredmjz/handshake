import { HAND_ART, HAND_BLOB, SHAKE_ART } from "@/components/art/art-markup";
import { cn } from "@/lib/utils";

export type HandKind = keyof typeof HAND_ART | "shake";

const BLOB_TINT: Partial<Record<HandKind, string>> = {
	food: "hsl(var(--category-food))",
	drinks: "hsl(var(--category-drinks))",
	stay: "hsl(var(--category-stay))",
	travel: "hsl(var(--category-travel))",
	groceries: "hsl(var(--category-groceries))",
	fun: "hsl(var(--category-fun))",
};

type HandProps = {
	kind: HandKind;
	// Drawn size in px; lines get thicker as the drawing gets smaller so it still reads at 46px.
	size: number;
	// A tinted blob behind the hand, in its category's colour.
	blob?: boolean;
	className?: string;
	label?: string;
};

// Each category is a hand holding its thing its own way; "new" writes, "shake" is two hands agreeing.
export function Hand({ kind, size, blob = false, className, label }: HandProps) {
	const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };

	if (kind === "shake") {
		return (
			<svg viewBox="0 0 120 80" width={size} height={(size * 2) / 3} className={cn("shrink-0", className)} {...a11y}>
				<g
					className="doodle"
					style={{ strokeWidth: size < 60 ? 4.2 : 2.6 }}
					transform="rotate(-2 60 40)"
					dangerouslySetInnerHTML={{ __html: SHAKE_ART }}
				/>
			</svg>
		);
	}

	const tint = blob ? BLOB_TINT[kind] : undefined;
	return (
		<svg viewBox="0 0 80 80" width={size} height={size} className={cn("shrink-0 overflow-hidden", className)} {...a11y}>
			{tint && <path transform="translate(2 3)" style={{ fill: tint }} d={HAND_BLOB} />}
			<g
				className="doodle"
				style={{ strokeWidth: size < 60 ? 2.6 : size < 110 ? 2.1 : 1.8 }}
				dangerouslySetInnerHTML={{ __html: HAND_ART[kind] }}
			/>
		</svg>
	);
}

// The hand inside a coloured disc, as on entry rows and the category picker.
export function HandDisc({
	kind,
	size,
	className,
	label,
}: {
	kind: HandKind;
	size: number;
	className?: string;
	label?: string;
}) {
	const tint = BLOB_TINT[kind];
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
				!tint && "border-[1.5px] border-border-strong",
				className
			)}
			style={{ width: size, height: size, background: tint }}
		>
			{kind === "shake" ? (
				<Hand kind="shake" size={size * 0.82} label={label} />
			) : (
				<Hand kind={kind} size={size} label={label} />
			)}
		</span>
	);
}
