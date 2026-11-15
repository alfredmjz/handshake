import type { Debt, GroupSummary, Item } from "@/lib/ledger";
import { pendingPaymentBetween, readPayment, recordingRule } from "@/lib/payment-rules";
import type { EntryRow, MemberRow, Role } from "@/lib/sync/types";
import { byLabel } from "@/lib/utils";

// A bill's items, or one item rebuilt from its shares for a bill stored without them.
export function billItems(entry: EntryRow): Item[] {
	if (entry.items && entry.items.length > 0) return entry.items;
	const payer = entry.shares.find((s) => s.paidCents > 0)?.memberId ?? entry.createdByMemberId;
	return [
		{
			id: `${entry.id}-item`,
			amountCents: entry.amountCents,
			paidBy: payer,
			splitAmong: entry.shares.filter((s) => s.owedCents > 0).map((s) => s.memberId),
		},
	];
}

export type SettleState = "settled" | "owes" | "owed" | "waiting";

export type SettleRow = {
	member: MemberRow;
	balanceCents: number;
	state: SettleState;
	// What they owe others, and what others owe them.
	owes: Debt[];
	owed: Debt[];
	owesCents: number;
	owedCents: number;
};

const sum = (debts: Debt[]) => debts.reduce((total, d) => total + d.amountCents, 0);

// One row per person on Settle up: everyone still in the group, and anyone who left with money open.
// You first, then by name. A pending payment of theirs makes them "waiting"; otherwise anyone who still
// owes someone "owes", even when others owe them more.
export function settleRows(
	members: MemberRow[],
	summary: GroupSummary,
	pending: EntryRow[],
	myMemberId: string | null
): SettleRow[] {
	const balance = new Map(summary.people.map((p) => [p.memberId, p.balanceCents]));
	const waiting = new Set(pending.flatMap((e) => e.shares.map((s) => s.memberId)));
	return members
		.map((member): SettleRow => {
			const balanceCents = balance.get(member.id) ?? 0;
			const owes = summary.debts.filter((d) => d.fromMemberId === member.id);
			const owed = summary.debts.filter((d) => d.toMemberId === member.id);
			const state: SettleState = waiting.has(member.id)
				? "waiting"
				: owes.length > 0
					? "owes"
					: owed.length > 0
						? "owed"
						: "settled";
			return { member, balanceCents, state, owes, owed, owesCents: sum(owes), owedCents: sum(owed) };
		})
		.filter((row) => !row.member.deletedAt || row.state !== "settled")
		.sort(
			(a, b) =>
				Number(b.member.id === myMemberId) - Number(a.member.id === myMemberId) ||
				byLabel(a.member.displayName, b.member.displayName) ||
				byLabel(a.member.id, b.member.id)
		);
}

export type PaymentCard =
	// A debt to settle: Shake on it opens the payment editor.
	| { kind: "record"; from: string; to: string; amountCents: number; debt: Debt }
	// A pending payment this person answers: Shake on it confirms it. `debt` is the debt it pays, if any.
	| { kind: "answer"; entry: EntryRow; entryId: string; from: string; to: string; amountCents: number; debt?: Debt }
	// A pending payment waiting for the other side; `canUndo` when this person recorded it.
	| {
			kind: "waiting";
			entry: EntryRow;
			entryId: string;
			from: string;
			to: string;
			amountCents: number;
			canUndo: boolean;
			debt?: Debt;
	  };

// The payment cards for one person: their debts either way (or the pending payment between the pair
// in its place), their other pending payments, and, for owners and members, debts between two people who
// can't answer for themselves.
export function paymentCards(
	debts: Debt[],
	pending: EntryRow[],
	members: MemberRow[],
	me: { memberId: string; role: Role }
): PaymentCard[] {
	const byId = new Map(members.map((m) => [m.id, m]));
	const cards: PaymentCard[] = [];
	const used = new Set<string>();

	const pendingCard = (entry: EntryRow, debt?: Debt): PaymentCard | null => {
		const payment = readPayment(entry, me.memberId);
		if (!payment) return null;
		const sides = {
			entry,
			entryId: entry.id,
			from: payment.from,
			to: payment.to,
			amountCents: entry.amountCents,
			debt,
		};
		return payment.answeringAs ? { kind: "answer", ...sides } : { kind: "waiting", ...sides, canUndo: payment.mayUndo };
	};
	const pendingBetween = (a: string, b: string) =>
		pendingPaymentBetween(
			pending.filter((e) => !used.has(e.id)),
			a,
			b
		);

	for (const debt of debts) {
		const mine = debt.fromMemberId === me.memberId || debt.toMemberId === me.memberId;
		const forOthers =
			!mine &&
			me.role !== "guest" &&
			recordingRule(me.memberId, byId.get(debt.fromMemberId), byId.get(debt.toMemberId)).mayRecord;
		if (!mine && !forOthers) continue;
		const waiting = mine ? pendingBetween(debt.fromMemberId, debt.toMemberId) : undefined;
		const card = waiting ? pendingCard(waiting, debt) : null;
		if (waiting && card) {
			used.add(waiting.id);
			cards.push(card);
		} else {
			cards.push({ kind: "record", from: debt.fromMemberId, to: debt.toMemberId, amountCents: debt.amountCents, debt });
		}
	}
	for (const entry of pending) {
		if (used.has(entry.id) || !entry.shares.some((s) => s.memberId === me.memberId)) continue;
		const card = pendingCard(entry);
		if (card) cards.push(card);
	}
	return cards;
}

// Active guests with a login: the people completing the group takes access from.
export function guestsLosingAccess(members: MemberRow[]): MemberRow[] {
	return members
		.filter((m) => m.role === "guest" && m.userId !== null && !m.deletedAt)
		.sort((a, b) => byLabel(a.displayName, b.displayName));
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

// "Two payments", for headings; digits past ten.
export function countPayments(n: number): string {
	return `${WORDS[n] ?? String(n)} payment${n === 1 ? "" : "s"}`;
}
