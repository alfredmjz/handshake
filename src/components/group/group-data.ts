import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { useCurrentUser } from "@/lib/auth";
import { useEntries, useGroupCategory, useGroupSummary, useOpenConflicts } from "@/lib/entries";
import { groupView, type GroupView } from "@/lib/group-access";
import { useUnsyncedIds } from "@/lib/groups";
import { db } from "@/lib/local-db";
import { byMemberName } from "@/lib/members";

// The group and its people (by name, those who left too) as the current user sees them, in one read.
export function useGroupView(groupId: string): GroupView | null | undefined {
	const { id: userId } = useCurrentUser();
	return useLiveQuery(async () => {
		const group = (await db.groups.get(groupId)) ?? null;
		const members = (await db.members.where("groupId").equals(groupId).toArray()).sort(byMemberName);
		return groupView({ group, members, userId });
	}, [groupId, userId]);
}

// Everything the group screens read, from the device: undefined until the group, its people and its entries
// have loaded; null as for useGroupView.
export function useGroupData(groupId: string) {
	const view = useGroupView(groupId);
	const entries = useEntries(groupId);
	const summary = useGroupSummary(groupId);
	const conflicts = useOpenConflicts(groupId);
	const unsynced = useUnsyncedIds();
	const category = useGroupCategory(groupId);

	const conflictedIds = useMemo(() => new Set((conflicts ?? []).map((c) => c.entryId)), [conflicts]);

	if (view === null) return null;
	if (view === undefined || entries === undefined) return undefined;
	return {
		...view,
		entries,
		summary,
		conflicts: conflicts ?? [],
		conflictedIds,
		unsynced: unsynced ?? new Set<string>(),
		category,
	};
}

export type GroupData = NonNullable<ReturnType<typeof useGroupData>>;
