import type { EntryRow, MemberRow, PaymentStatus } from "@/lib/sync/types";

// The handshake rules for a payment (ADR-008), as the server's private.* helpers decide them. Pure.

export type PaymentSide = "payer" | "receiver";

export type PaymentReading = {
	from: string;
	to: string;
	status: PaymentStatus;
	// While pending, the side it waits for: the receiver once the payer has signed, else the payer. Once
	// declined, the side that declined. Otherwise null.
	answerer: string | null;
	// Which sides have confirmed it.
	signed: { payer: boolean; receiver: boolean };
	// When it started to count, or null when it doesn't.
	countedAt: string | null;
	// From `me`'s view: their side and the other one (null when they aren't a side), the side they would answer
	// as, and whether they may undo it (they recorded it). The last two only while pending.
	side: PaymentSide | null;
	other: string | null;
	answeringAs: PaymentSide | null;
	mayUndo: boolean;
};

type Person = Pick<MemberRow, "id" | "userId" | "deletedAt">;
type PaymentLike = Pick<EntryRow, "kind" | "paymentStatus" | "shares">;

// private.can_answer: still in the group, with a login.
export function canAnswer(member: Pick<MemberRow, "userId" | "deletedAt"> | undefined): boolean {
	return !!member && member.userId !== null && !member.deletedAt;
}

// A payment as `me` (a member id) sees it, or null for a bill or a payment missing a side. private.payment_sides:
// the payer has paid cents, the receiver owed cents.
export function readPayment(entry: EntryRow, me?: string | null): PaymentReading | null {
	if (entry.kind !== "payment" || !entry.paymentStatus) return null;
	const from = entry.shares.find((s) => s.paidCents > 0)?.memberId;
	const to = entry.shares.find((s) => s.owedCents > 0)?.memberId;
	if (!from || !to) return null;

	const status = entry.paymentStatus;
	const pending = status === "pending";
	const signed = { payer: !!entry.payerConfirmedAt, receiver: !!entry.receiverConfirmedAt };
	const side: PaymentSide | null = !me ? null : me === from ? "payer" : me === to ? "receiver" : null;
	return {
		from,
		to,
		status,
		answerer: pending || status === "declined" ? (signed.payer ? to : from) : null,
		signed,
		countedAt: status === "confirmed" ? (entry.confirmedAt ?? entry.updatedAt) : null,
		side,
		other: side === "payer" ? to : side === "receiver" ? from : null,
		answeringAs: pending && side && !signed[side] ? side : null,
		mayUndo: pending && !!me && entry.createdByMemberId === me,
	};
}

// private.may_record_payment and private.payment_answerer IS NULL: someone may record a payment they are one
// side of, or one between two people who can't answer it themselves; it counts at once unless the payer
// recorded it and the receiver can answer (the receiver saying they were paid is enough, migration 014).
export function recordingRule(
	recorder: string | null | undefined,
	from?: Person,
	to?: Person
): { mayRecord: boolean; countsAtOnce: boolean } {
	const own = !!recorder && (recorder === from?.id || recorder === to?.id);
	return {
		mayRecord: own || (!canAnswer(from) && !canAnswer(to)),
		countsAtOnce: !(!!recorder && recorder === from?.id && canAnswer(to)),
	};
}

// The payment waiting for an answer between two people, either way round.
export function pendingPaymentBetween<T extends PaymentLike>(
	entries: readonly T[],
	a: string,
	b: string
): T | undefined {
	return entries.find(
		(e) =>
			e.kind === "payment" &&
			e.paymentStatus === "pending" &&
			e.shares.some((s) => s.memberId === a) &&
			e.shares.some((s) => s.memberId === b)
	);
}
