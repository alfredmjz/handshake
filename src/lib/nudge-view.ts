import { shortDate } from "@/lib/group-view";
import { summarizeGroup, type LedgerEntry, type LedgerMember } from "@/lib/ledger";
import type { EntryRow, GroupRow, MemberRow, NudgeRow } from "@/lib/sync/types";

// One nudge per sender and person per this long (the server's rule).
export const NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// A nudge sent to the current user, for the bell.
export type ReceivedNudge = NudgeRow & {
	groupName: string;
	// The sender's display name in that group.
	fromName: string;
	// Not yet seen on this device (markNudgesSeen).
	unseen: boolean;
};

export const newestFirst = (a: NudgeRow, b: NudgeRow) =>
	b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

// What `from` owes `to` right now (summarizeGroup's pairwise debt), 0 when nothing.
export function currentDebt(entries: Iterable<LedgerEntry>, members: LedgerMember[], from: string, to: string): number {
	return (
		summarizeGroup(entries, members).debts.find((d) => d.fromMemberId === from && d.toMemberId === to)?.amountCents ?? 0
	);
}

// The newest nudge from one person to another, or null.
export function lastNudge(nudges: NudgeRow[], fromMemberId: string, toMemberId: string): NudgeRow | null {
	return (
		nudges.filter((n) => n.fromMemberId === fromMemberId && n.toMemberId === toMemberId).sort(newestFirst)[0] ?? null
	);
}

// Whether that nudge still blocks another: sent less than 24 hours before `now` (ISO).
export function nudgedRecently(nudge: NudgeRow | null, now: string): boolean {
	return !!nudge && Date.parse(now) - Date.parse(nudge.createdAt) < NUDGE_INTERVAL_MS;
}

// When the sender may nudge again (ISO), or null when they may now.
export function nextNudgeAt(nudge: NudgeRow | null, now: string): string | null {
	return nudgedRecently(nudge, now) ? new Date(Date.parse(nudge!.createdAt) + NUDGE_INTERVAL_MS).toISOString() : null;
}

// Nudges to `userId` in groups they are still in (not deleted), newest first, with names and seen state.
export function receivedNudges(
	nudges: NudgeRow[],
	groups: GroupRow[],
	members: MemberRow[],
	userId: string,
	seenIds: ReadonlySet<string>
): ReceivedNudge[] {
	const liveGroups = new Map(groups.filter((g) => !g.deletedAt).map((g) => [g.id, g]));
	const byId = new Map(members.map((m) => [m.id, m]));
	const mine = new Set(
		members.filter((m) => m.userId === userId && !m.deletedAt && liveGroups.has(m.groupId)).map((m) => m.id)
	);
	return nudges
		.filter((n) => mine.has(n.toMemberId) && liveGroups.has(n.groupId))
		.sort(newestFirst)
		.map((n) => ({
			...n,
			groupName: liveGroups.get(n.groupId)!.name,
			fromName: byId.get(n.fromMemberId)?.displayName ?? "Someone",
			unseen: !seenIds.has(n.id),
		}));
}

export function unseenCount(received: ReceivedNudge[]): number {
	return received.filter((n) => n.unseen).length;
}

function localDay(at: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

// When a nudge was sent, by local calendar day: "today", "yesterday", "3 Nov" ("31 Dec 2025" in another year).
export function sentWhen(createdAt: string, now: Date): string {
	const sent = localDay(new Date(createdAt));
	const today = localDay(now);
	if (sent === today) return "today";
	if (sent === localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return "yesterday";
	return shortDate(createdAt, today);
}

// The nudge, unless the nudged person has since paid the sender a payment that counted: then null, so an old
// nudge does not come back with a later debt.
export function openNudge(nudge: NudgeRow | null, entries: EntryRow[], from: string, to: string): NudgeRow | null {
	if (!nudge) return null;
	const answered = entries.some(
		(e) =>
			e.kind === "payment" &&
			e.paymentStatus === "confirmed" &&
			!e.deletedAt &&
			e.shares.some((s) => s.memberId === to && s.paidCents > 0) &&
			e.shares.some((s) => s.memberId === from && s.owedCents > 0) &&
			Date.parse(e.confirmedAt ?? e.updatedAt) > Date.parse(nudge.createdAt)
	);
	return answered ? null : nudge;
}
