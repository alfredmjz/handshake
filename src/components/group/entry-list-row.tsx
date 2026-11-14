import { Link } from "react-router";

import { HandDisc } from "@/components/art/hand";
import { RowAmount } from "@/components/money";
import { Badge } from "@/components/ui/badge";
import { ListRow } from "@/components/ui/list";
import { Inline } from "@/components/ui/stack";
import type { Names } from "@/lib/group-access";
import { effectOn, payerIds } from "@/lib/group-view";
import { formatAmount } from "@/lib/money";
import { readPayment } from "@/lib/payment-rules";
import type { EntryRow } from "@/lib/sync/types";
import { cn } from "@/lib/utils";

// "Sam paid Alex $30.00" / "You paid Sam $10.00".
export function paymentTitle(entry: EntryRow, names: Names): string {
	const payment = readPayment(entry);
	return `${names.of(payment?.from)} paid ${names.inSentence(payment?.to)} ${formatAmount(entry.amountCents)}`;
}

// Where a payment stands, in a few words.
export function paymentState(entry: EntryRow, names: Names): string {
	const payment = readPayment(entry);
	switch (payment?.status) {
		case "pending":
			return `Waiting for ${names.inSentence(payment.answerer)}`;
		case "declined":
			return "Declined";
		case "undone":
			return "Undone";
		default:
			return "Payment";
	}
}

// "Alex paid $90.00", "Alex and Sam paid $100.00".
export function payersLine(entry: EntryRow, names: Names): string {
	return `${names.list(payerIds(entry), "start")} paid ${formatAmount(entry.amountCents)}`;
}

type EntryListRowProps = {
	entry: EntryRow;
	names: Names;
	myMemberId: string | null | undefined;
	unsynced: boolean;
	needsResolving: boolean;
	to: string;
	// Added while the list was open: it drops in and keeps a wash until you've had a moment to see it.
	arrived?: boolean;
};

// One bill or payment in a group's list: its hand, what it was, and what it means for you.
export function EntryListRow({
	entry,
	names,
	myMemberId,
	unsynced,
	needsResolving,
	to,
	arrived = false,
}: EntryListRowProps) {
	const isPayment = entry.kind === "payment";
	const involved = entry.shares.some((s) => s.memberId === myMemberId);
	const effect = effectOn(entry, myMemberId);
	const line = isPayment ? paymentState(entry, names) : payersLine(entry, names);

	return (
		<ListRow
			asChild
			className={cn(
				arrived &&
					// Waits for the editor to close, so the drop happens where you can see it.
					"-mx-2 rounded-lg px-2 [animation:land_var(--duration-moment)_var(--ease-bounce)_280ms_both,just-changed_4s_var(--ease-out)_280ms_both]"
			)}
			leading={<HandDisc kind={isPayment ? "shake" : (entry.category ?? "new")} size={46} />}
			title={isPayment ? paymentTitle(entry, names) : entry.description}
			subtitle={
				unsynced || needsResolving ? (
					<Inline gap="control" wrap={false}>
						<span className="truncate">{line}</span>
						{needsResolving && <Badge tone="owe">Needs resolving</Badge>}
						{unsynced && <Badge tone="waiting">Not synced yet</Badge>}
					</Inline>
				) : (
					line
				)
			}
			trailing={
				isPayment ? (
					!involved && <span className="type-label text-muted-foreground">not involved</span>
				) : effect.kind === "lent" ? (
					<RowAmount label="you lent" cents={effect.cents} tone="owed" />
				) : effect.kind === "owe" ? (
					<RowAmount label="you owe" cents={effect.cents} tone="owe" />
				) : effect.kind === "even" ? (
					<RowAmount label="your share" cents={effect.cents} tone="neutral" />
				) : (
					<span className="type-label text-muted-foreground">not involved</span>
				)
			}
		>
			<Link to={to} />
		</ListRow>
	);
}
