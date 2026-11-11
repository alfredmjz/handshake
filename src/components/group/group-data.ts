import { useMemo } from "react";

import { useEntries, useGroupCategory, useGroupSummary, useOpenConflicts } from "@/lib/entries";
import { useGroup, useUnsyncedIds } from "@/lib/groups";
import { useMembers, useMyMember } from "@/lib/members";
import { allowedWhenCompleted, may, type Action } from "@/lib/permissions";
import type { GroupRow, MemberRow } from "@/lib/sync/types";

export type Names = {
	// "You" for the current person, "Jo (left)" for someone who left, the name otherwise.
	of(memberId: string | null | undefined): string;
	// The same, lower-case "you" for the middle of a sentence ("Sam paid you").
	inSentence(memberId: string | null | undefined): string;
	member(memberId: string | null | undefined): MemberRow | undefined;
};

export function makeNames(members: readonly MemberRow[], myMemberId: string | null | undefined): Names {
	const byId = new Map(members.map((m) => [m.id, m]));
	const of = (id: string | null | undefined) => {
		if (!id) return "Someone";
		if (id === myMemberId) return "You";
		const m = byId.get(id);
		if (!m) return "Someone";
		return m.deletedAt ? `${m.displayName} (left)` : m.displayName;
	};
	return {
		of,
		inSentence: (id) => (id && id === myMemberId ? "you" : of(id)),
		member: (id) => (id ? byId.get(id) : undefined),
	};
}

// Whether the current person may do this here: their role allows it, and a completed group allows it.
export function canDo(group: GroupRow | null | undefined, me: MemberRow | null | undefined, action: Action): boolean {
	if (!group || !me) return false;
	return may(action, me.role) && (!group.completedAt || allowedWhenCompleted(action));
}

// Everything the group screens read, from the device.
export function useGroupData(groupId: string) {
	const group = useGroup(groupId);
	const members = useMembers(groupId, { includeLeft: true });
	const me = useMyMember(groupId);
	const entries = useEntries(groupId);
	const summary = useGroupSummary(groupId);
	const conflicts = useOpenConflicts(groupId);
	const unsynced = useUnsyncedIds();
	const category = useGroupCategory(groupId);

	const names = useMemo(() => makeNames(members ?? [], me?.id), [members, me?.id]);
	const active = useMemo(() => (members ?? []).filter((m) => !m.deletedAt), [members]);
	const conflictedIds = useMemo(() => new Set((conflicts ?? []).map((c) => c.entryId)), [conflicts]);

	return {
		group,
		members: members ?? [],
		active,
		me,
		entries: entries ?? [],
		summary,
		conflicts: conflicts ?? [],
		conflictedIds,
		unsynced: unsynced ?? new Set<string>(),
		category,
		names,
		loading: group === undefined || members === undefined || me === undefined || entries === undefined,
		can: (action: Action) => canDo(group, me, action),
	};
}

export type GroupData = ReturnType<typeof useGroupData>;
