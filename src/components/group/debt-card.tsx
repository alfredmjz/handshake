import type { ReactNode } from "react";

import { PaymentArrow } from "@/components/editors/payment-arrow";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type DebtCardProps = {
	from: { id: string; name: string };
	to: { id: string; name: string };
	amountCents: number;
	// A status badge under each face: "Paid", "Waiting".
	fromBadge?: ReactNode;
	toBadge?: ReactNode;
	// A payment waiting for its handshake: the two dotted lines, signed so far by one. Replaces the badges.
	signatures?: ReactNode;
	// What's happening, in a few words: "You owe Sam", "Priya says they paid you".
	sentence?: ReactNode;
	// A line under it: a decline note.
	detail?: ReactNode;
	// Your buttons, in one row on your side of the card (under your face).
	actions?: ReactNode;
	actionsSide?: "from" | "to";
	// Cards in a run alternate their arrow, as on Settle up.
	tilt?: "up" | "down";
	// A band at the bottom: a nudge to you.
	notice?: ReactNode;
};

// Everything between you and one person on one card: the payer's face, the amount on a squiggle to the
// receiver's face, a badge under each face for their part of the handshake, and your buttons on your side.
export function DebtCard({
	from,
	to,
	amountCents,
	fromBadge,
	toBadge,
	signatures,
	sentence,
	detail,
	actions,
	actionsSide = "to",
	tilt = "up",
	notice,
}: DebtCardProps) {
	const words = (sentence || detail) && (
		<p className={cn("flex min-w-0 flex-col gap-0.5", actions && actionsSide === "from" && "items-end text-right")}>
			{sentence && <span className="type-body-sm font-medium">{sentence}</span>}
			{detail && <span className="type-label text-muted-foreground">{detail}</span>}
		</p>
	);
	const buttons = actions && <div className="flex shrink-0 items-center gap-control">{actions}</div>;

	return (
		<Card>
			<PaymentArrow from={from} to={to} amountCents={amountCents} tilt={tilt} />
			{signatures}
			{!signatures && (fromBadge || toBadge) && (
				<div className="-mt-1 flex items-start justify-between gap-stack">
					<span className="flex min-w-0">{fromBadge}</span>
					<span className="flex min-w-0 justify-end">{toBadge}</span>
				</div>
			)}
			{(words || buttons) && (
				<div className="flex items-center justify-between gap-stack">
					{actionsSide === "from" ? (
						<>
							{buttons}
							{words}
						</>
					) : (
						<>
							{words}
							{buttons}
						</>
					)}
				</div>
			)}
			{notice}
		</Card>
	);
}
