import { useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import type { GroupData } from "@/components/group/group-data";
import { useRun } from "@/components/group/use-run";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import type { Names } from "@/lib/group-access";
import { formatAmount } from "@/lib/money";
import { readPayment, type PaymentReading } from "@/lib/payment-rules";
import type { EntryRow } from "@/lib/sync/types";

// What a pending payment is waiting for, from the side of the person it was read for.
export function pendingSentence(payment: PaymentReading, names: Names): string {
	if (payment.mayUndo) return `Waiting for ${names.inSentence(payment.other)}`;
	if (payment.side === "receiver") return `${names.of(payment.from)} says they paid you`;
	if (payment.side === "payer") return `${names.of(payment.to)} says you paid them`;
	return `Waiting for ${names.inSentence(payment.answerer)}`;
}

type PaymentButtonsProps = {
	entry: EntryRow;
	data: GroupData;
	// After a confirm that made the payment count.
	onConfirmed?: (entryId: string) => void;
	size?: "sm" | "default";
};

// Confirm and Decline for the side still to answer; Undo for whoever recorded it, while it waits.
export function PaymentButtons({ entry, data, onConfirmed, size = "sm" }: PaymentButtonsProps) {
	const run = useRun();
	const [declining, setDeclining] = useState(false);
	const [note, setNote] = useState("");
	const me = data.me?.id;
	const payment = readPayment(entry, me);
	if (payment?.status !== "pending" || !me) return null;

	if (payment.answeringAs && data.may("payment.respond")) {
		return (
			<>
				<Button
					size={size}
					onClick={async () => {
						const plan = await run({ type: "confirmPayment", groupId: entry.groupId, entryId: entry.id });
						if (plan.ok && plan.mutations.length > 0) onConfirmed?.(entry.id);
					}}
				>
					Confirm
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
					description={`${pendingSentence(payment, data.names)} ${formatAmount(entry.amountCents)}.`}
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

	if (payment.mayUndo && data.may("payment.undo")) {
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
