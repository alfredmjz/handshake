import { useMemo } from "react";

import { useEntries, useGroupCategory, useGroupSummary, useOpenConflicts } from "@/lib/entries";
import { groupAccess } from "@/lib/group-access";
import { useGroup, useUnsyncedIds } from "@/lib/groups";
import { useMembers, useMyMember } from "@/lib/members";

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

	const access = useMemo(() => groupAccess({ group, members, me }), [group, members, me]);
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
		names: access.names,
		loading: group === undefined || members === undefined || me === undefined || entries === undefined,
		can: access.may,
	};
}

export type GroupData = ReturnType<typeof useGroupData>;
