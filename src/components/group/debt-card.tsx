import type { ReactNode } from "react";

import { PaymentArrow } from "@/components/editors/payment-arrow";
import { Card } from "@/components/ui/card";
import { Inline } from "@/components/ui/stack";

type DebtCardProps = {
	from: { id: string; name: string };
	to: { id: string; name: string };
	amountCents: number;
	// "You owe Sam", "Waiting for Sam", "Jo says they paid you".
	sentence: ReactNode;
	actions?: ReactNode;
	// A line under the sentence: a decline note, "Payment".
	detail?: ReactNode;
	// Cards in a run alternate their arrow, as on Settle up.
	tilt?: "up" | "down";
};

// A debt or payment between you and one person: their faces with the amount on a squiggle from the
// one who pays to the one who's paid, then what's happening and its buttons.
export function DebtCard({ from, to, amountCents, sentence, actions, detail, tilt = "up" }: DebtCardProps) {
	return (
		<Card>
			<PaymentArrow from={from} to={to} amountCents={amountCents} tilt={tilt} />
			<Inline justify="between" gap="stack">
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="type-body-sm font-medium">{sentence}</span>
					{detail && <span className="type-label text-muted-foreground">{detail}</span>}
				</span>
				{actions && <Inline gap="control">{actions}</Inline>}
			</Inline>
		</Card>
	);
}
