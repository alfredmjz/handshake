import { useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import type { GroupData, Names } from "@/components/group/group-data";
import { useRun } from "@/components/group/use-run";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { paymentSides } from "@/lib/changes";
import { formatAmount } from "@/lib/money";
import type { EntryRow } from "@/lib/sync/types";

// What a pending payment is waiting for, from the current person's side.
export function pendingSentence(entry: EntryRow, names: Names, myMemberId: string | null | undefined): string {
	const { from, to } = paymentSides(entry);
	if (entry.createdByMemberId === myMemberId) return `Waiting for ${names.inSentence(from === myMemberId ? to : from)}`;
	if (to === myMemberId) return `${names.of(from)} says they paid you`;
	if (from === myMemberId) return `${names.of(to)} says you paid them`;
	return `Waiting for ${names.inSentence(entry.payerConfirmedAt ? to : from)}`;
}

type PaymentButtonsProps = {
	entry: EntryRow;
	data: GroupData;
	// After a confirm that made the payment count.
	onConfirmed?: (entryId: string) => void;
	size?: "sm" | "default";
};

// Shake on it (confirm) and Decline for the side still to answer; Undo for whoever recorded it, while it waits.
export function PaymentButtons({ entry, data, onConfirmed, size = "sm" }: PaymentButtonsProps) {
	const run = useRun();
	const [declining, setDeclining] = useState(false);
	const [note, setNote] = useState("");
	const me = data.me?.id;
	if (entry.kind !== "payment" || entry.paymentStatus !== "pending" || !me) return null;

	const { from, to } = paymentSides(entry);
	const toAnswer = (me === from && !entry.payerConfirmedAt) || (me === to && !entry.receiverConfirmedAt);
	const mayUndo = entry.createdByMemberId === me && data.can("payment.undo");

	if (toAnswer && data.can("payment.respond")) {
		return (
			<>
				<Button
					size={size}
					onClick={async () => {
						const plan = await run({ type: "confirmPayment", groupId: entry.groupId, entryId: entry.id });
						if (plan.ok && plan.mutations.length > 0) onConfirmed?.(entry.id);
					}}
				>
					Shake on it
				</Button>
				<Button size={size} variant="outline" onClick={() => setDeclining(true)}>
					Decline
				</Button>
				<ConfirmDialog
					open={declining}
					onOpenChange={(open) => {
						setDeclining(open);
						if (!open) setNote("");
					}}
					title="Decline this payment?"
					description={`${pendingSentence(entry, data.names, me)} ${formatAmount(entry.amountCents)}.`}
					confirmLabel="Decline"
					onConfirm={async () => {
						await run({
							type: "declinePayment",
							groupId: entry.groupId,
							entryId: entry.id,
							note: note.trim() || null,
						});
						setNote("");
					}}
				>
					<Field label="Note" htmlFor={`decline-${entry.id}`} hint="Optional">
						<Textarea
							id={`decline-${entry.id}`}
							maxLength={200}
							placeholder="I didn't get this"
							value={note}
							onChange={(e) => setNote(e.target.value)}
						/>
					</Field>
				</ConfirmDialog>
			</>
		);
	}

	if (mayUndo) {
		return (
			<Button
				size={size}
				variant="outline"
				onClick={() => void run({ type: "undoPayment", groupId: entry.groupId, entryId: entry.id })}
			>
				Undo
			</Button>
		);
	}

	return null;
}
