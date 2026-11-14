import type { EntryRow, MemberRow } from "@/lib/sync/types";

// The handshake rules for a payment (ADR-008), as the server's private.* helpers decide them. Pure.

type PaymentLike = Pick<EntryRow, "kind" | "paymentStatus" | "shares">;
type Answerable = Pick<EntryRow, "shares" | "payerConfirmedAt" | "receiverConfirmedAt">;

// private.can_answer: still in the group, with a login.
export function canAnswer(member: Pick<MemberRow, "userId" | "deletedAt"> | undefined): boolean {
	return !!member && member.userId !== null && !member.deletedAt;
}

// private.payment_sides: the payer has paid cents, the receiver owed cents.
export function paymentSides(entry: Pick<EntryRow, "shares">): { from: string | undefined; to: string | undefined } {
	return {
		from: entry.shares.find((s) => s.paidCents > 0)?.memberId,
		to: entry.shares.find((s) => s.owedCents > 0)?.memberId,
	};
}

export function isPendingPayment(entry: Pick<EntryRow, "kind" | "paymentStatus">): boolean {
	return entry.kind === "payment" && entry.paymentStatus === "pending";
}

// The other side of a payment from this person.
export function counterpart(entry: Pick<EntryRow, "shares">, memberId: string): string | undefined {
	const { from, to } = paymentSides(entry);
	return from === memberId ? to : from;
}

// Which side this person would answer a pending payment as, or null when it isn't theirs to answer: a side
// that hasn't confirmed yet, the payer's first.
export function answeringSide(entry: Answerable, memberId: string | null | undefined): "payer" | "receiver" | null {
	if (!memberId) return null;
	const { from, to } = paymentSides(entry);
	if (memberId === from && !entry.payerConfirmedAt) return "payer";
	if (memberId === to && !entry.receiverConfirmedAt) return "receiver";
	return null;
}

// The side a pending payment waits for: the receiver once the payer has confirmed, else the payer.
export function awaitedSide(entry: Answerable): string | undefined {
	const { from, to } = paymentSides(entry);
	return entry.payerConfirmedAt ? to : from;
}

// Only whoever recorded a pending payment can undo it.
export function mayUndo(entry: Pick<EntryRow, "createdByMemberId">, memberId: string | null | undefined): boolean {
	return !!memberId && entry.createdByMemberId === memberId;
}

// Whether a payment recorded by `recorder` counts at once rather than waiting: only the payer needs the
// receiver to agree, and only when the receiver can answer. The receiver saying they were paid is enough
// on its own (migration 014), and payments recorded for others are between people who can't answer.
export function countsAtOnce(recorder: string, from: string, receiver: MemberRow | undefined): boolean {
	return recorder !== from || !canAnswer(receiver);
}

// Someone else may record a payment between two people only when neither can answer it themselves.
export function recordableForOthers(from: MemberRow | undefined, to: MemberRow | undefined): boolean {
	return !canAnswer(from) && !canAnswer(to);
}

// The payment waiting for an answer between two people, either way round.
export function pendingPaymentBetween<T extends PaymentLike>(
	entries: readonly T[],
	a: string,
	b: string
): T | undefined {
	return entries.find(
		(e) => isPendingPayment(e) && e.shares.some((s) => s.memberId === a) && e.shares.some((s) => s.memberId === b)
	);
}
