import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EditorDialog } from "@/components/editor-dialog";
import { PaymentArrow } from "@/components/editors/payment-arrow";
import { Notice } from "@/components/notices";
import { showRefusal } from "@/components/signed-in-layout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Stack } from "@/components/ui/stack";
import { useCurrentUser } from "@/lib/auth";
import { paymentCountsAtOnce, pendingPaymentBetween, useCommit, type GroupState } from "@/lib/changes";
import { useEntries, useGroupSummary } from "@/lib/entries";
import { useGroup } from "@/lib/groups";
import { useMembers, useMyMember } from "@/lib/members";
import { parseAmount } from "@/lib/money";
import { allowedWhenCompleted, may } from "@/lib/permissions";

export type PaymentEditorProps = {
	groupId: string;
	// Member ids: `from` pays `to`.
	from: string;
	to: string;
	// Defaults to the whole debt between the two.
	amountCents?: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	// Called with the new entry id when the payment counts at once (no confirmation needed).
	onCounted?: (entryId: string) => void;
};

function today() {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function amountText(cents: number) {
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

// "You paid Sam" or "Jo paid you": who and which way are set by the debt it was opened from.
export function PaymentEditor({ groupId, from, to, amountCents, open, onOpenChange, onCounted }: PaymentEditorProps) {
	const commit = useCommit();
	const user = useCurrentUser();
	const group = useGroup(groupId);
	const members = useMembers(groupId, { includeLeft: true });
	const me = useMyMember(groupId);
	const entries = useEntries(groupId);
	const summary = useGroupSummary(groupId);
	const [amount, setAmount] = useState("");
	const [entryDate, setEntryDate] = useState(today);
	const [notes, setNotes] = useState("");
	const [saving, setSaving] = useState(false);

	const debt = summary?.debts.find((d) => d.fromMemberId === from && d.toMemberId === to)?.amountCents;
	const defaultCents = amountCents ?? debt;

	// Fresh fields each time it opens, with the whole debt filled in once the balances have loaded.
	const [filled, setFilled] = useState(false);
	useEffect(() => {
		if (!open) setFilled(false);
		else if (!filled && summary !== undefined) {
			setAmount(defaultCents ? amountText(defaultCents) : "");
			setEntryDate(today());
			setNotes("");
			setFilled(true);
		}
	}, [open, filled, summary, defaultCents]);

	const payer = members?.find((m) => m.id === from);
	const receiver = members?.find((m) => m.id === to);
	const name = (id: string) => (id === me?.id ? "You" : (members?.find((m) => m.id === id)?.displayName ?? "Someone"));
	const title =
		me?.id === to
			? `${name(from)} paid you`
			: me?.id === from
				? `You paid ${name(to)}`
				: `${name(from)} paid ${name(to)}`;
	const other = me?.id === from ? to : from;

	const state: GroupState | null =
		group && members && entries && me
			? {
					group,
					members,
					entries,
					conflicts: [],
					invites: [],
					me: { memberId: me.id, role: me.role, isAnonymous: user.isAnonymous },
				}
			: null;
	const countsAtOnce = state ? paymentCountsAtOnce(state, from, to) : false;
	const waiting = entries ? pendingPaymentBetween(entries, from, to) : undefined;
	const own = me?.id === from || me?.id === to;
	const action = own ? "payment.record.own" : "payment.record.others";

	const loaded = group !== undefined && members !== undefined && me !== undefined && entries !== undefined && !!summary;
	const blocked = !loaded
		? null
		: !me
			? "You're not in this group."
			: group?.completedAt && !allowedWhenCompleted(action)
				? "This group is completed."
				: !may(action, me.role)
					? "Guests can't record this payment."
					: waiting
						? `A payment with ${name(other)} is already waiting.`
						: null;

	const cents = parseAmount(amount);
	const valid = cents !== null && cents >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(entryDate) && !!payer && !!receiver;

	const save = async () => {
		if (cents === null) return;
		setSaving(true);
		try {
			const plan = await commit({
				type: "recordPayment",
				groupId,
				from,
				to,
				amountCents: cents,
				entryDate,
				notes: notes.trim() ? notes : null,
			});
			if (!plan.ok) {
				showRefusal(plan.code, plan.reason);
				return;
			}
			onOpenChange(false);
			if (countsAtOnce) {
				if (plan.createdId) onCounted?.(plan.createdId);
			} else {
				toast(`Waiting for ${name(other)} to confirm`);
			}
		} catch {
			// The layout already said it couldn't save on this device.
		} finally {
			setSaving(false);
		}
	};

	return (
		<EditorDialog
			open={open}
			onOpenChange={onOpenChange}
			title={loaded ? title : "Payment"}
			submitLabel="Record payment"
			canSubmit={loaded && valid && !blocked && !saving}
			onSubmit={save}
		>
			{blocked && <Notice tone={waiting ? "waiting" : "neutral"}>{blocked}</Notice>}
			{payer && receiver && (
				<PaymentArrow
					from={{ id: payer.id, name: name(payer.id) }}
					to={{ id: receiver.id, name: name(receiver.id) }}
					amountCents={cents}
					size={56}
				/>
			)}
			<Stack gap="control">
				<Field
					label="Amount"
					htmlFor="payment-amount"
					hint={
						countsAtOnce
							? own
								? `${name(other)} can't confirm, so it counts at once.`
								: "Neither can confirm, so it counts at once."
							: `Counts once ${name(other)} confirms.`
					}
				>
					<div className="flex items-baseline gap-0.5">
						<span className="type-stat-xl" aria-hidden>
							$
						</span>
						<Input
							id="payment-amount"
							variant="amount"
							inputMode="decimal"
							autoComplete="off"
							placeholder="0.00"
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
							aria-invalid={amount !== "" && cents === null}
						/>
					</div>
				</Field>
			</Stack>
			<div className="grid gap-section sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
				<Field label="Date" htmlFor="payment-date">
					<Input
						id="payment-date"
						type="date"
						required
						value={entryDate}
						onChange={(e) => setEntryDate(e.target.value)}
					/>
				</Field>
				<Field label="Note" htmlFor="payment-note">
					<Input
						id="payment-note"
						maxLength={1000}
						autoComplete="off"
						value={notes}
						onChange={(e) => setNotes(e.target.value)}
					/>
				</Field>
			</div>
		</EditorDialog>
	);
}
