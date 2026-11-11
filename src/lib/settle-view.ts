import { canAnswer, paymentSides } from "@/lib/changes";
import { byLabel } from "@/lib/groups";
import type { Debt, GroupSummary, Item, Share } from "@/lib/ledger";
import type { EntryRow, MemberRow, Role } from "@/lib/sync/types";

// A part of a bill that rounding moved off its exact share: `cents` is what was stored minus the share
// rounded on its own (the payer covering the odd cent, or a cent taken off someone else's part).
export type RoundingNote = { memberId: string; payerId: string; cents: number };

function gcd(a: bigint, b: bigint): bigint {
	return b === 0n ? a : gcd(b, a % b);
}

// Where computeShares had to move cents so a payer's parts add up, per person and payer.
export function roundingNotes(items: Item[], shares: Share[]): RoundingNote[] {
	const notes: RoundingNote[] = [];
	const shareOf = new Map(shares.map((s) => [s.memberId, s]));
	for (const payer of new Set(items.map((i) => i.paidBy))) {
		const payerItems = items.filter((i) => i.paidBy === payer);
		let d = 1n;
		for (const item of payerItems) {
			const n = BigInt(item.splitAmong.length);
			d = (d / gcd(d, n)) * n;
		}
		const exact = new Map<string, bigint>();
		for (const item of payerItems) {
			const each = BigInt(item.amountCents) * (d / BigInt(item.splitAmong.length));
			for (const who of item.splitAmong) exact.set(who, (exact.get(who) ?? 0n) + each);
		}
		const people = new Set([...exact.keys(), payer]);
		for (const who of people) {
			const num = exact.get(who) ?? 0n;
			const rounded = Number((2n * num + d) / (2n * d));
			const stored = shareOf.get(who)?.owedTo[payer] ?? 0;
			if (stored !== rounded) notes.push({ memberId: who, payerId: payer, cents: stored - rounded });
		}
	}
	return notes;
}

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
	| { kind: "record"; from: string; to: string; amountCents: number }
	// A pending payment this person answers: Shake on it confirms it.
	| { kind: "answer"; entryId: string; from: string; to: string; amountCents: number }
	// A pending payment waiting for the other side; `canUndo` when this person recorded it.
	| { kind: "waiting"; entryId: string; from: string; to: string; amountCents: number; canUndo: boolean };

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

	const pendingCard = (entry: EntryRow): PaymentCard | null => {
		const { from, to } = paymentSides(entry);
		if (!from || !to) return null;
		const mayAnswer =
			(me.memberId === from && !entry.payerConfirmedAt) || (me.memberId === to && !entry.receiverConfirmedAt);
		return mayAnswer
			? { kind: "answer", entryId: entry.id, from, to, amountCents: entry.amountCents }
			: {
					kind: "waiting",
					entryId: entry.id,
					from,
					to,
					amountCents: entry.amountCents,
					canUndo: entry.createdByMemberId === me.memberId,
				};
	};
	const pendingBetween = (a: string, b: string) =>
		pending.find(
			(e) => !used.has(e.id) && e.shares.some((s) => s.memberId === a) && e.shares.some((s) => s.memberId === b)
		);

	for (const debt of debts) {
		const mine = debt.fromMemberId === me.memberId || debt.toMemberId === me.memberId;
		const forOthers =
			!mine && me.role !== "guest" && !canAnswer(byId.get(debt.fromMemberId)) && !canAnswer(byId.get(debt.toMemberId));
		if (!mine && !forOthers) continue;
		const waiting = mine ? pendingBetween(debt.fromMemberId, debt.toMemberId) : undefined;
		const card = waiting ? pendingCard(waiting) : null;
		if (waiting && card) {
			used.add(waiting.id);
			cards.push(card);
		} else {
			cards.push({ kind: "record", from: debt.fromMemberId, to: debt.toMemberId, amountCents: debt.amountCents });
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

// "Kim", "Kim and Lee", "Kim, Lee and Mo".
export function listNames(names: string[]): string {
	if (names.length <= 1) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

// "Two payments", for headings; digits past ten.
export function countPayments(n: number): string {
	return `${WORDS[n] ?? String(n)} payment${n === 1 ? "" : "s"}`;
}
