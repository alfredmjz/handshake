import { Link } from "react-router";

import { HandDisc } from "@/components/art/hand";
import type { Names } from "@/components/group/group-data";
import { RowAmount } from "@/components/money";
import { Badge } from "@/components/ui/badge";
import { ListRow } from "@/components/ui/list";
import { Inline } from "@/components/ui/stack";
import { paymentSides } from "@/lib/changes";
import { effectOn, payerIds, sentenceList } from "@/lib/group-view";
import { formatAmount } from "@/lib/money";
import type { EntryRow } from "@/lib/sync/types";

// "Sam paid Alex $30.00" / "You paid Sam $10.00".
export function paymentTitle(entry: EntryRow, names: Names): string {
	const { from, to } = paymentSides(entry);
	return `${names.of(from)} paid ${names.inSentence(to)} ${formatAmount(entry.amountCents)}`;
}

// Where a payment stands, in a few words.
export function paymentState(entry: EntryRow, names: Names): string {
	const { from, to } = paymentSides(entry);
	switch (entry.paymentStatus) {
		case "pending":
			return `Waiting for ${names.inSentence(entry.payerConfirmedAt ? to : from)}`;
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
	return `${sentenceList(payerIds(entry).map(names.of))} paid ${formatAmount(entry.amountCents)}`;
}

type EntryListRowProps = {
	entry: EntryRow;
	names: Names;
	myMemberId: string | null | undefined;
	unsynced: boolean;
	needsResolving: boolean;
	to: string;
};

// One bill or payment in a group's list: its hand, what it was, and what it means for you.
export function EntryListRow({ entry, names, myMemberId, unsynced, needsResolving, to }: EntryListRowProps) {
	const isPayment = entry.kind === "payment";
	const involved = entry.shares.some((s) => s.memberId === myMemberId);
	const effect = effectOn(entry, myMemberId);
	const line = isPayment ? paymentState(entry, names) : payersLine(entry, names);

	return (
		<ListRow
			asChild
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
