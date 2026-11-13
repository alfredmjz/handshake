import { useState, type ReactNode } from "react";

import { CheckDoodle } from "@/components/art/doodles";
import { Signatures } from "@/components/art/signatures";
import { Face } from "@/components/art/face";
import { PaymentEditor } from "@/components/editors/payment-editor";
import { ShakeConfirmation } from "@/components/editors/shake-confirmation";
import { DebtCard } from "@/components/group/debt-card";
import type { GroupData } from "@/components/group/group-data";
import { NudgeButton } from "@/components/group/nudge-button";
import { NudgeNotice } from "@/components/group/nudge-notice";
import { PaymentButtons, pendingSentence } from "@/components/group/payment-buttons";
import { Amount } from "@/components/money";
import { EmptyState } from "@/components/notices";
import { Badge } from "@/components/ui/badge";
import { HairlineFigure } from "@/components/art/figures/figure";
import { square } from "@/components/art/figures/square";
import { Button } from "@/components/ui/button";
import { List, ListHeading, ListRow } from "@/components/ui/list";
import { Stack } from "@/components/ui/stack";
import { canAnswer, paymentSides } from "@/lib/changes";
import type { Debt } from "@/lib/ledger";
import type { EntryRow } from "@/lib/sync/types";
import { formatAmount } from "@/lib/money";
import { everOwed } from "@/lib/shell-view";
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
	// People sign with their own name, you included.
	const signedName = (id: string) => data.members.find((m) => m.id === id)?.displayName ?? names.of(id);

	return (
		<Stack gap="section">
			{mine.length === 0 ? (
				// Laid out as Entries' empty state: the cube the cursor knocks about, then one line.
				<EmptyState
					art={<HairlineFigure mount={square} value={0.9} className="aspect-auto h-full w-full" />}
					title={everOwed(data.entries, me) ? "You're all square." : "Nothing owed yet."}
				/>
			) : (
				<Stack gap="stack">
					{mine.map(({ otherId, debt, pending }, n) => {
						if (!me) return null;
						const person = (id: string) => ({ id, name: names.of(id) });
						const sides = pending ? paymentSides(pending) : null;
						// The arrow follows the debt; a payment with nobody owing anything follows the payment.
						const fromId = debt?.fromMemberId ?? sides?.from ?? otherId;
						const toId = debt?.toMemberId ?? sides?.to ?? otherId;
						const amountCents = debt?.amountCents ?? pending?.amountCents ?? 0;
						const iOwe = fromId === me;

						// A badge under each face for their part of the handshake; your buttons go on your side.
						const badges = new Map<string, ReactNode>();
						let actions: ReactNode = null;
						if (pending && sides?.from && sides.to) {
							const recorder = pending.createdByMemberId;
							const target = recorder === sides.from ? sides.to : sides.from;
							const part = pending.amountCents !== amountCents ? ` ${formatAmount(pending.amountCents)}` : "";
							badges.set(
								recorder,
								<Badge tone="settled">
									<CheckDoodle />
									{recorder === sides.from ? "Paid" : "Received"}
									{part}
								</Badge>
							);
							if (target !== me) badges.set(target, <Badge tone="waiting">Waiting</Badge>);
							actions = (
								<PaymentButtons entry={pending} data={data} onConfirmed={target === me ? setShake : undefined} />
							);
						} else if (debt) {
							actions = (
								<>
									{mayRecordOwn && (
										<Button
											size="sm"
											variant="secondary"
											onClick={() =>
												record({ from: debt.fromMemberId, to: debt.toMemberId, amountCents: debt.amountCents })
											}
										>
											Settle
										</Button>
									)}
									{!iOwe && <NudgeButton data={data} memberId={otherId} />}
								</>
							);
						}

						return (
							<DebtCard
								key={otherId}
								from={person(fromId)}
								to={person(toId)}
								amountCents={amountCents}
								tilt={n % 2 === 0 ? "up" : "down"}
								fromBadge={badges.get(fromId)}
								signatures={
									pending && sides?.from && sides.to ? (
										<Signatures
											write={false}
											payer={{
												name: signedName(sides.from),
												role: "paid",
												signed: pending.createdByMemberId === sides.from,
											}}
											receiver={{
												name: signedName(sides.to),
												role: "received",
												signed: pending.createdByMemberId === sides.to,
											}}
										/>
									) : undefined
								}
								toBadge={badges.get(toId)}
								actions={actions}
								actionsSide={iOwe ? "from" : "to"}
								sentence={
									pending
										? pendingSentence(pending, names, me)
										: iOwe
											? `You owe ${names.of(otherId)}`
											: `${names.of(otherId)} owes you`
								}
								detail={pending?.notes ?? undefined}
								notice={
									debt &&
									iOwe && (
										<NudgeNotice
											groupId={data.group?.id ?? ""}
											fromId={otherId}
											fromName={names.of(otherId)}
											meId={me}
											entries={data.entries}
											onPaid={
												mayRecordOwn && !pending
													? (cents) => record({ from: me, to: otherId, amountCents: cents })
													: undefined
											}
										/>
									)
								}
							/>
						);
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
													Settle
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
