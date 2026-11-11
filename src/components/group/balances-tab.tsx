import { useState } from "react";

import { CheckDoodle } from "@/components/art/doodles";
import { Face } from "@/components/art/face";
import { PaymentEditor } from "@/components/editors/payment-editor";
import { ShakeConfirmation } from "@/components/editors/shake-confirmation";
import { DebtCard } from "@/components/group/debt-card";
import type { GroupData } from "@/components/group/group-data";
import { NudgeButton } from "@/components/group/nudge-button";
import { NudgeNotice } from "@/components/group/nudge-notice";
import { PaymentButtons, pendingSentence } from "@/components/group/payment-buttons";
import { Amount } from "@/components/money";
import { Button } from "@/components/ui/button";
import { List, ListHeading, ListRow } from "@/components/ui/list";
import { Inline, Stack } from "@/components/ui/stack";
import { canAnswer, paymentSides } from "@/lib/changes";
import type { Debt } from "@/lib/ledger";
import type { EntryRow } from "@/lib/sync/types";
import { byText } from "@/lib/utils";

type PaymentDraft = { from: string; to: string; amountCents?: number };

// One card per person you have a debt or a waiting payment with.
type Counterpart = { otherId: string; debt?: Debt; pending?: EntryRow };

export function BalancesTab({ data }: { data: GroupData }) {
	const [draft, setDraft] = useState<PaymentDraft | null>(null);
	const [editorOpen, setEditorOpen] = useState(false);
	const [shake, setShake] = useState<string | null>(null);
	const me = data.me?.id;
	const { names } = data;
	const debts = data.summary?.debts ?? [];

	const record = (next: PaymentDraft) => {
		setDraft(next);
		setEditorOpen(true);
	};

	const byOther = new Map<string, Counterpart>();
	for (const debt of debts) {
		if (debt.fromMemberId !== me && debt.toMemberId !== me) continue;
		const otherId = debt.fromMemberId === me ? debt.toMemberId : debt.fromMemberId;
		byOther.set(otherId, { otherId, debt });
	}
	for (const entry of data.entries) {
		if (entry.kind !== "payment" || entry.paymentStatus !== "pending") continue;
		const { from, to } = paymentSides(entry);
		if (!from || !to || (from !== me && to !== me)) continue;
		const otherId = from === me ? to : from;
		byOther.set(otherId, { ...byOther.get(otherId), otherId, pending: entry });
	}
	const mine = [...byOther.values()].sort(byText((c) => names.of(c.otherId)));

	const others = debts
		.filter((d) => d.fromMemberId !== me && d.toMemberId !== me)
		.sort(byText((d) => `${names.of(d.fromMemberId)} ${names.of(d.toMemberId)}`));
	const mayRecordOthers = data.can("payment.record.others");
	const mayRecordOwn = data.can("payment.record.own");

	return (
		<Stack gap="section">
			{mine.length === 0 ? (
				<Inline gap="control" className="type-body py-row">
					<CheckDoodle className="size-6" />
					You're all square.
				</Inline>
			) : (
				<Stack gap="stack">
					{mine.map(({ otherId, debt, pending }, n) => {
						const person = (id: string) => ({ id, name: names.of(id) });
						const pendingCard = pending && (
							<DebtCard
								key={`${otherId}:pending`}
								from={person(paymentSides(pending).from ?? otherId)}
								to={person(paymentSides(pending).to ?? otherId)}
								amountCents={pending.amountCents}
								sentence={pendingSentence(pending, names, me)}
								detail={pending.notes ?? undefined}
								tilt={n % 2 === 0 ? "down" : "up"}
								actions={<PaymentButtons entry={pending} data={data} onConfirmed={setShake} />}
							/>
						);
						if (!debt) return pendingCard;
						const iOwe = debt.fromMemberId === me;
						const debtCard = (
							<DebtCard
								key={otherId}
								from={person(debt.fromMemberId)}
								to={person(debt.toMemberId)}
								amountCents={debt.amountCents}
								tilt={n % 2 === 0 ? "up" : "down"}
								sentence={iOwe ? `You owe ${names.of(otherId)}` : `${names.of(otherId)} owes you`}
								actions={
									!pending && (
										<>
											{mayRecordOwn && (
												<Button
													size="sm"
													variant="secondary"
													onClick={() =>
														record({ from: debt.fromMemberId, to: debt.toMemberId, amountCents: debt.amountCents })
													}
												>
													{iOwe ? "Record payment" : "Record received"}
												</Button>
											)}
											{!iOwe && <NudgeButton data={data} memberId={otherId} />}
										</>
									)
								}
								notice={
									iOwe &&
									me && (
										<NudgeNotice
											groupId={data.group?.id ?? ""}
											fromId={otherId}
											fromName={names.of(otherId)}
											meId={me}
											entries={data.entries}
											onPaid={
												mayRecordOwn && !pending
													? (amountCents) => record({ from: me, to: otherId, amountCents })
													: undefined
											}
										/>
									)
								}
							/>
						);
						return pending ? [debtCard, pendingCard] : debtCard;
					})}
				</Stack>
			)}

			{others.length > 0 && (
				<div>
					<ListHeading>Everyone else</ListHeading>
					<List>
						{others.map((debt) => {
							const recordable =
								mayRecordOthers &&
								!canAnswer(names.member(debt.fromMemberId)) &&
								!canAnswer(names.member(debt.toMemberId));
							return (
								<ListRow
									key={`${debt.fromMemberId}:${debt.toMemberId}`}
									leading={<Face seed={debt.fromMemberId} name={names.of(debt.fromMemberId)} size={36} />}
									title={`${names.of(debt.fromMemberId)} owes ${names.of(debt.toMemberId)}`}
									trailing={
										<>
											<Amount cents={debt.amountCents} />
											{recordable && (
												<Button
													size="sm"
													variant="secondary"
													onClick={() =>
														record({ from: debt.fromMemberId, to: debt.toMemberId, amountCents: debt.amountCents })
													}
												>
													Record payment
												</Button>
											)}
										</>
									}
								/>
							);
						})}
					</List>
				</div>
			)}

			{draft && (
				<PaymentEditor
					groupId={data.group?.id ?? ""}
					from={draft.from}
					to={draft.to}
					amountCents={draft.amountCents}
					open={editorOpen}
					onOpenChange={setEditorOpen}
					onCounted={setShake}
				/>
			)}
			<ShakeConfirmation groupId={data.group?.id ?? ""} entryId={shake} onClose={() => setShake(null)} />
		</Stack>
	);
}
