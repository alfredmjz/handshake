import { useEffect, useRef, useState, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";

// Money is always Funnel Display. Owed to you is cobalt, you owe is tomato, everything else is ink.
const amountVariants = cva("whitespace-nowrap", {
	variants: {
		size: { sm: "type-money", md: "type-money-lg", lg: "type-stat", xl: "type-stat-xl" },
		tone: { owed: "text-owed", owe: "text-owe", neutral: "text-ink", inherit: "" },
	},
	defaultVariants: { size: "sm", tone: "neutral" },
});

type AmountProps = VariantProps<typeof amountVariants> & {
	cents: number;
	// Show the sign (+$60.00 / −$10.00) instead of the bare amount.
	signed?: boolean;
	className?: string;
};

export function Amount({ cents, size, tone, signed = false, className }: AmountProps) {
	const text = signed && cents > 0 ? `+${formatAmount(cents)}` : formatAmount(signed ? cents : Math.abs(cents));
	return <span className={cn(amountVariants({ size, tone }), className)}>{text}</span>;
}

// An amount that, when it changes, rolls to the new value instead of swapping: fast at first, then easing in.
export function RollingAmount({ cents, ...props }: AmountProps) {
	const [shown, setShown] = useState(cents);
	const from = useRef(cents);

	useEffect(() => {
		const start = from.current;
		from.current = cents;
		if (start === cents || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			setShown(cents);
			return;
		}
		// Starts once a closing editor is out of the way, so the roll is seen rather than finished behind it.
		const began = performance.now() + 280;
		const duration = 900;
		let frame = requestAnimationFrame(function step(now) {
			const t = Math.max(0, Math.min(1, (now - began) / duration));
			const eased = 1 - Math.pow(1 - t, 4);
			setShown(Math.round(start + (cents - start) * eased));
			if (t < 1) frame = requestAnimationFrame(step);
		});
		return () => cancelAnimationFrame(frame);
	}, [cents]);

	return <Amount cents={shown} {...props} className={cn("tabular-nums", props.className)} />;
}

export type Standing = "owed" | "owe" | "settled";

export function standingOf(balanceCents: number): Standing {
	return balanceCents > 0 ? "owed" : balanceCents < 0 ? "owe" : "settled";
}

// A small label over an amount, right-aligned at the end of a row: "you lent / $40.00".
export function RowAmount({
	label,
	cents,
	tone,
}: {
	label: ReactNode;
	cents: number;
	tone: "owed" | "owe" | "neutral";
}) {
	return (
		<>
			<span className="type-caption text-muted-foreground">{label}</span>
			<Amount cents={cents} tone={tone} />
		</>
	);
}
