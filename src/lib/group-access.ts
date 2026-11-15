import { joinNames } from "@/lib/group-view";
import type { LedgerMember } from "@/lib/ledger";
import { allowedWhenCompleted, may, type Action } from "@/lib/permissions";
import type { GroupRow, MemberRow, Role } from "@/lib/sync/types";

// A group's people as one person sees them: what they may do, what everyone is called, whose names are
// taken, and who takes over from an owner who leaves. Pure.

export function toLedgerMembers(members: readonly MemberRow[]): LedgerMember[] {
	return members.map((m) => ({ id: m.id, displayName: m.displayName, hasLogin: m.userId !== null }));
}

// private.require_unique_name: names are unique among the group's active people, ignoring case and outer spaces.
export function isNameTaken(
	members: readonly MemberRow[],
	name: string,
	exceptMemberId: string | null = null
): boolean {
	const key = name.trim().toLowerCase();
	return members.some((m) => !m.deletedAt && m.id !== exceptMemberId && m.displayName.trim().toLowerCase() === key);
}

type Heir = Pick<MemberRow, "id" | "role" | "userId" | "deletedAt" | "joinedAt">;

// Postgres sorts a missing joined_at last.
const byJoined = (a: Heir, b: Heir) =>
	a.joinedAt === b.joinedAt
		? 0
		: a.joinedAt === null
			? 1
			: b.joinedAt === null
				? -1
				: a.joinedAt.localeCompare(b.joinedAt);

// private.hand_over: who becomes owner when `leavingId` goes, the member with a login who joined first (then by
// id), or undefined when nobody can and the group goes.
export function nextOwner<T extends Heir>(members: readonly T[], leavingId: string): T | undefined {
	return members
		.filter((m) => m.role === "member" && m.userId !== null && !m.deletedAt && m.id !== leavingId)
		.sort((a, b) => byJoined(a, b) || a.id.localeCompare(b.id))[0];
}

// Why the gate refuses an action: not in the group, the group is completed, or the role doesn't allow it.
export type Denial = "not-member" | "completed" | "owner-only" | "guests";

// private.require's gate after the group exists: a member, an open group (or an action a completed group
// allows), then the role matrix.
export function denial(
	group: Pick<GroupRow, "completedAt"> | null | undefined,
	role: Role | null | undefined,
	action: Action
): Denial | null {
	if (!role) return "not-member";
	if (group?.completedAt && !allowedWhenCompleted(action)) return "completed";
	if (may(action, role)) return null;
	return may(action, "owner") && !may(action, "member") ? "owner-only" : "guests";
}

// What a guest is told for the actions screens offer; anything else is "Guests can't do this."
const GUEST_WORDS: Partial<Record<Action, string>> = {
	"entry.update": "Guests can't edit bills.",
	"payment.record.others": "Guests can't record this payment.",
};

export const NOT_IN_GROUP = "You're not in this group.";

const WORDS: Record<Exclude<Denial, "guests">, string> = {
	"not-member": NOT_IN_GROUP,
	completed: "This group is completed.",
	"owner-only": "Only the group's owner can do this.",
};

export type Names = {
	// "You" for the current person, "Jo (left)" for someone who left, "Someone" for no one known.
	of(memberId: string | null | undefined): string;
	// The same, lower-case "you" for the middle of a sentence ("Sam paid you").
	inSentence(memberId: string | null | undefined): string;
	// The name they sign with: their own, never "You" or "(left)"; "Someone" for no one known.
	signed(memberId: string | null | undefined): string;
	// "You and Sam" or "Alex and you" to start a sentence; "Sam and you" in the middle of one.
	list(memberIds: readonly string[], at: "start" | "middle"): string;
	member(memberId: string | null | undefined): MemberRow | undefined;
	isMe(memberId: string | null | undefined): boolean;
};

export function makeNames(members: readonly MemberRow[], myMemberId: string | null | undefined): Names {
	const byId = new Map(members.map((m) => [m.id, m]));
	const isMe = (id: string | null | undefined) => !!id && id === myMemberId;
	const signed = (id: string | null | undefined) => (id ? byId.get(id)?.displayName : undefined) ?? "Someone";
	const of = (id: string | null | undefined) => {
		if (isMe(id)) return "You";
		const m = id ? byId.get(id) : undefined;
		return m?.deletedAt ? `${m.displayName} (left)` : signed(id);
	};
	const inSentence = (id: string | null | undefined) => (isMe(id) ? "you" : of(id));
	return {
		of,
		inSentence,
		signed,
		list: (ids, at) => joinNames(ids.map((id, i) => (at === "start" && i === 0 ? of(id) : inSentence(id)))),
		member: (id) => (id ? byId.get(id) : undefined),
		isMe,
	};
}

// A group as the current person sees it: everyone in it (those who left too), who is still in, their own
// active row, what they may do and what everyone is called.
export type GroupView = {
	group: GroupRow;
	members: MemberRow[];
	active: MemberRow[];
	me: MemberRow | null;
	may(action: Action): boolean;
	// The sentence a screen shows when they may not, or null when they may.
	whyNot(action: Action): string | null;
	names: Names;
};

// undefined while either input is loading; null when the group is missing or deleted, which screens treat
// like not being in it.
export function groupView(input: {
	group: GroupRow | null | undefined;
	members: MemberRow[] | undefined;
	userId: string;
}): GroupView | null | undefined {
	const { group, members, userId } = input;
	if (group === undefined || members === undefined) return undefined;
	if (!group || group.deletedAt) return null;
	const me = members.find((m) => m.userId === userId && !m.deletedAt) ?? null;
	return {
		group,
		members,
		active: members.filter((m) => !m.deletedAt),
		me,
		may: (action) => denial(group, me?.role, action) === null,
		whyNot: (action) => {
			const why = denial(group, me?.role, action);
			if (!why) return null;
			return why === "guests" ? (GUEST_WORDS[action] ?? "Guests can't do this.") : WORDS[why];
		},
		names: makeNames(members, me?.id),
	};
}
