import { allowedWhenCompleted, may, type Action } from "@/lib/permissions";
import type { GroupRow, MemberRow, Role } from "@/lib/sync/types";

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

const WORDS: Record<Exclude<Denial, "guests">, string> = {
	"not-member": "You're not in this group.",
	completed: "This group is completed.",
	"owner-only": "Only the group's owner can do this.",
};

export type Names = {
	// "You" for the current person, "Jo (left)" for someone who left, "Someone" for no one known.
	of(memberId: string | null | undefined): string;
	// The same, lower-case "you" for the middle of a sentence ("Sam paid you").
	inSentence(memberId: string | null | undefined): string;
	member(memberId: string | null | undefined): MemberRow | undefined;
	isMe(memberId: string | null | undefined): boolean;
};

export function makeNames(members: readonly MemberRow[], myMemberId: string | null | undefined): Names {
	const byId = new Map(members.map((m) => [m.id, m]));
	const isMe = (id: string | null | undefined) => !!id && id === myMemberId;
	const of = (id: string | null | undefined) => {
		if (!id) return "Someone";
		if (isMe(id)) return "You";
		const m = byId.get(id);
		if (!m) return "Someone";
		return m.deletedAt ? `${m.displayName} (left)` : m.displayName;
	};
	return {
		of,
		inSentence: (id) => (isMe(id) ? "you" : of(id)),
		member: (id) => (id ? byId.get(id) : undefined),
		isMe,
	};
}

export type GroupAccess = {
	// Whether the current person may do this here now.
	may(action: Action): boolean;
	// The sentence a screen shows when they may not, or null when they may.
	whyNot(action: Action): string | null;
	names: Names;
};

// The group as one person sees it: "may I?" and "who is this?". `me` is their active member row. Nothing
// is allowed until the group has loaded.
export function groupAccess(view: {
	group: Pick<GroupRow, "completedAt"> | null | undefined;
	members: readonly MemberRow[] | null | undefined;
	me: MemberRow | null | undefined;
}): GroupAccess {
	const { group, me } = view;
	return {
		may: (action) => !!group && denial(group, me?.role, action) === null,
		whyNot: (action) => {
			const why = denial(group, me?.role, action);
			if (!why) return null;
			return why === "guests" ? (GUEST_WORDS[action] ?? "Guests can't do this.") : WORDS[why];
		},
		names: makeNames(view.members ?? [], me?.id),
	};
}
