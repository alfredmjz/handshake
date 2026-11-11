import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useParams } from "react-router";

import { CheckDoodle } from "@/components/art/doodles";
import { Face } from "@/components/art/face";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PaymentArrow } from "@/components/editors/payment-arrow";
import { PaymentEditor } from "@/components/editors/payment-editor";
import { ShakeConfirmation } from "@/components/editors/shake-confirmation";
import { CompleteSummary } from "@/components/group/complete-summary";
import { Amount } from "@/components/money";
import { EmptyState, Notice } from "@/components/notices";
import { BackLink, Screen, ScreenHeader, Section } from "@/components/screen";
import { showRefusal } from "@/components/signed-in-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { List, ListRow } from "@/components/ui/list";
import { Inline, Stack } from "@/components/ui/stack";
import { useCommit, type Intent } from "@/lib/changes";
import { useGroupSummary, usePendingPayments } from "@/lib/entries";
import { useGroup } from "@/lib/groups";
import { useMembers, useMyMember } from "@/lib/members";
import { formatAmount } from "@/lib/money";
import { allowedWhenCompleted, may } from "@/lib/permissions";
import {
	countPayments,
	guestsLosingAccess,
	paymentCards,
	settleRows,
	type PaymentCard,
	type SettleRow,
} from "@/lib/settle-view";

type PaymentDraft = { from: string; to: string; amountCents: number };

export function SettleUpPage() {
	const { groupId = "" } = useParams();
	const commit = useCommit();
	const group = useGroup(groupId);
	const members = useMembers(groupId, { includeLeft: true });
	const me = useMyMember(groupId);
	const summary = useGroupSummary(groupId);
	const pending = usePendingPayments(groupId);

	const [expanded, setExpanded] = useState<string | null>(null);
	const [payment, setPayment] = useState<PaymentDraft | null>(null);
	const [paymentOpen, setPaymentOpen] = useState(false);
	const [shake, setShake] = useState<string | null>(null);
	const [declining, setDeclining] = useState<string | null>(null);
	const [declineNote, setDeclineNote] = useState("");
	const [completing, setCompleting] = useState(false);

	if (group === undefined || members === undefined || me === undefined || !summary || !pending) return null;
	if (group === null || group.deletedAt) {
		return (
			<Screen>
				<BackLink to="/">Groups</BackLink>
				<EmptyState title="This group isn't on this device." />
			</Screen>
		);
	}

	const run = async (intent: Intent) => {
		try {
			const plan = await commit(intent);
			if (!plan.ok) showRefusal(plan.code, plan.reason);
			return plan.ok;
		} catch {
			return false;
		}
	};

	const completed = !!group.completedAt;
	const allowed = (action: Parameters<typeof may>[0]) =>
		!!me && may(action, me.role) && (!completed || allowedWhenCompleted(action));
	const byId = new Map(members.map((m) => [m.id, m]));
	const name = (id: string) => (id === me?.id ? "You" : (byId.get(id)?.displayName ?? "Someone"));
	const object = (id: string) => (id === me?.id ? "you" : name(id));

	const rows = settleRows(members, summary, pending, me?.id ?? null);
	const settled = rows.filter((r) => r.state === "settled").length;
	const cards = me ? paymentCards(summary.debts, pending, members, { memberId: me.id, role: me.role }) : [];
	const allMine = cards.length === summary.debts.length && cards.every((c) => c.kind === "record");

	const openPayment = (draft: PaymentDraft) => {
		setPayment(draft);
		setPaymentOpen(true);
	};
	const confirm = async (entryId: string) => {
		if (await run({ type: "confirmPayment", groupId, entryId })) setShake(entryId);
	};
	const decline = async () => {
		if (!declining) return;
		const entryId = declining;
		setDeclining(null);
		await run({ type: "declinePayment", groupId, entryId, note: declineNote.trim() ? declineNote : null });
	};
	const complete = async () => {
		setCompleting(false);
		await run({ type: "completeGroup", groupId });
	};

	const guests = guestsLosingAccess(members);
	const owing = [...summary.debts].sort(
		(x, y) =>
			name(x.fromMemberId).localeCompare(name(y.fromMemberId), undefined, { sensitivity: "base" }) ||
			name(x.toMemberId).localeCompare(name(y.toMemberId), undefined, { sensitivity: "base" })
	);
	const debtors = [...new Set(summary.debts.map((d) => d.fromMemberId))];
	const totalOwed = summary.debts.reduce((sum, d) => sum + d.amountCents, 0);

	return (
		<Screen>
			<ScreenHeader
				back={{ to: `/groups/${groupId}`, label: group.name }}
				title="Settle up"
				lead={`${settled} of ${rows.length} settled`}
			/>

			{completed && <Notice>This group is completed.</Notice>}

			<List aria-label="People">
				{rows.map((row) => (
					<PersonRow
						key={row.member.id}
						row={row}
						name={name}
						object={object}
						me={me?.id ?? null}
						open={expanded === row.member.id}
						onToggle={() => setExpanded((id) => (id === row.member.id ? null : row.member.id))}
					/>
				))}
			</List>

			{cards.length > 0 && (
				<Section
					title={
						allMine
							? `${countPayments(cards.length)} ${cards.length === 1 ? "squares" : "square"} everyone`
							: "Your payments"
					}
				>
					<Stack>
						{cards.map((card, n) => (
							<PaymentCardView
								key={card.kind === "record" ? `${card.from}-${card.to}` : card.entryId}
								card={card}
								tilt={n % 2 === 0 ? "up" : "down"}
								me={me?.id ?? null}
								name={name}
								object={object}
								canRecord={allowed(
									card.from === me?.id || card.to === me?.id ? "payment.record.own" : "payment.record.others"
								)}
								canAnswer={allowed("payment.respond")}
								canUndo={allowed("payment.undo")}
								onShake={() => {
									if (card.kind === "record")
										openPayment({ from: card.from, to: card.to, amountCents: card.amountCents });
									else if (card.kind === "answer") void confirm(card.entryId);
								}}
								onDecline={() => {
									if (card.kind !== "answer") return;
									setDeclineNote("");
									setDeclining(card.entryId);
								}}
								onUndo={() =>
									card.kind === "waiting" && void run({ type: "undoPayment", groupId, entryId: card.entryId })
								}
							/>
						))}
					</Stack>
				</Section>
			)}

			{allowed("group.complete") && (
				<div>
					<Button variant="outline" size="lg" className="w-full sm:w-auto" onClick={() => setCompleting(true)}>
						Complete group
					</Button>
				</div>
			)}

			{payment && (
				<PaymentEditor
					groupId={groupId}
					from={payment.from}
					to={payment.to}
					amountCents={payment.amountCents}
					open={paymentOpen}
					onOpenChange={setPaymentOpen}
					onCounted={setShake}
				/>
			)}
			<ShakeConfirmation groupId={groupId} entryId={shake} onClose={() => setShake(null)} />

			<ConfirmDialog
				open={declining !== null}
				onOpenChange={(open) => !open && setDeclining(null)}
				title="Decline this payment?"
				description="It won't count."
				confirmLabel="Decline"
				tone="destructive"
				onConfirm={decline}
			>
				<Field label="Note" htmlFor="decline-note" hint="Optional">
					<Input
						id="decline-note"
						maxLength={200}
						placeholder="I didn't get this"
						value={declineNote}
						onChange={(e) => setDeclineNote(e.target.value)}
					/>
				</Field>
			</ConfirmDialog>

			<ConfirmDialog
				open={completing}
				onOpenChange={setCompleting}
				title={`Complete ${group.name}?`}
				description={
					<span className="type-body font-semibold text-foreground">
						{summary.debts.length === 0
							? "Everyone is settled."
							: `${debtors.length === 1 && debtors[0] === me?.id ? "You still owe" : `${debtors.length} ${debtors.length === 1 ? "person still owes" : "people still owe"}`} ${formatAmount(totalOwed)}`}
					</span>
				}
				confirmLabel="Complete group"
				onConfirm={complete}
			>
				<CompleteSummary
					rows={owing.map((d) => ({
						key: `${d.fromMemberId}-${d.toMemberId}`,
						fromId: d.fromMemberId,
						text: `${name(d.fromMemberId)} → ${object(d.toMemberId)}`,
						cents: d.amountCents,
					}))}
					waiting={pending.length}
					guests={guests.map((g) => g.displayName)}
				/>
			</ConfirmDialog>
		</Screen>
	);
}

function PersonRow({
	row,
	name,
	object,
	me,
	open,
	onToggle,
}: {
	row: SettleRow;
	name: (id: string) => string;
	object: (id: string) => string;
	me: string | null;
	open: boolean;
	onToggle: () => void;
}) {
	const id = row.member.id;
	const debts = [...row.owes, ...row.owed];
	return (
		<>
			<ListRow
				asChild
				leading={<Face seed={id} name="" size={36} faded={!!row.member.deletedAt} />}
				title={`${name(id)}${row.member.deletedAt ? " (left)" : ""}`}
				trailing={
					<span className="flex items-center gap-control">
						<span className="flex flex-col items-end gap-0.5">
							<RowState row={row} />
						</span>
						<ChevronDown
							aria-hidden
							className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
						/>
					</span>
				}
			>
				<button type="button" aria-expanded={open} aria-controls={`debts-${id}`} onClick={onToggle} />
			</ListRow>
			{open && (
				<li id={`debts-${id}`} className="list-none pb-row pl-[calc(36px+var(--space-stack))]">
					{debts.length === 0 ? (
						<span className="type-body-sm text-muted-foreground">All square.</span>
					) : (
						<ul className="flex flex-col gap-control">
							{debts.map((d) => (
								<li
									key={`${d.fromMemberId}-${d.toMemberId}`}
									className="type-body-sm flex items-baseline justify-between gap-stack"
								>
									<span className="min-w-0">
										{name(d.fromMemberId)} {d.fromMemberId === me ? "owe" : "owes"} {object(d.toMemberId)}
									</span>
									<Amount
										cents={d.amountCents}
										tone={d.fromMemberId === me ? "owe" : d.toMemberId === me ? "owed" : "neutral"}
									/>
								</li>
							))}
						</ul>
					)}
				</li>
			)}
		</>
	);
}

// The canvas: a signed balance in its tone (+$60.00 cobalt, −$50.00 tomato), or a badge.
function RowState({ row }: { row: SettleRow }) {
	if (row.state === "waiting") return <Badge tone="waiting">Waiting for confirmation</Badge>;
	if (row.state === "settled")
		return (
			<Badge tone="settled">
				<CheckDoodle /> Settled
			</Badge>
		);
	const tone = row.balanceCents > 0 ? "owed" : row.balanceCents < 0 ? "owe" : "neutral";
	return <Amount cents={row.balanceCents} signed size="md" tone={tone} />;
}

function PaymentCardView({
	card,
	tilt,
	me,
	name,
	object,
	canRecord,
	canAnswer,
	canUndo,
	onShake,
	onDecline,
	onUndo,
}: {
	card: PaymentCard;
	tilt: "up" | "down";
	me: string | null;
	name: (id: string) => string;
	object: (id: string) => string;
	canRecord: boolean;
	canAnswer: boolean;
	canUndo: boolean;
	onShake: () => void;
	onDecline: () => void;
	onUndo: () => void;
}) {
	const pays = `${name(card.from)} ${card.from === me ? "pay" : "pays"} ${object(card.to)}`;
	const other = card.from === me ? card.to : card.from;
	const text =
		card.kind === "record"
			? pays
			: card.kind === "answer"
				? card.to === me
					? `${name(card.from)} says they paid you`
					: `${name(card.to)} says you paid them`
				: `Waiting for ${name(other)}`;

	return (
		<Card className="gap-control">
			<PaymentArrow
				from={{ id: card.from, name: name(card.from) }}
				to={{ id: card.to, name: name(card.to) }}
				amountCents={card.amountCents}
				tilt={tilt}
			/>
			<Inline justify="between" wrap={false} className="gap-stack">
				<span className="type-body-sm min-w-0 font-medium">{text}</span>
				<Inline gap="control" wrap={false}>
					{card.kind === "answer" && canAnswer && (
						<Button size="sm" variant="ghost" onClick={onDecline}>
							Decline
						</Button>
					)}
					{card.kind === "waiting" && card.canUndo && canUndo && (
						<Button size="sm" variant="ghost" onClick={onUndo}>
							Undo
						</Button>
					)}
					{((card.kind === "record" && canRecord) || (card.kind === "answer" && canAnswer)) && (
						<Button size="sm" onClick={onShake}>
							Settle
						</Button>
					)}
				</Inline>
			</Inline>
		</Card>
	);
}
