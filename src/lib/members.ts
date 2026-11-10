import { useLiveQuery } from "dexie-react-hooks";

import { useCurrentUser } from "@/lib/auth";
import { byLabel } from "@/lib/groups";
import { db } from "@/lib/local-db";

// People in the group by name. includeLeft keeps those who left, for names on old bills and debts.
export function useMembers(groupId: string, { includeLeft = false } = {}) {
	return useLiveQuery(
		async () =>
			(await db.members.where("groupId").equals(groupId).toArray())
				.filter((m) => includeLeft || !m.deletedAt)
				.sort((a, b) => byLabel(a.displayName, b.displayName) || byLabel(a.id, b.id)),
		[groupId, includeLeft]
	);
}

// The current user's active member row in the group: undefined while loading, null when they have none.
export function useMyMember(groupId: string) {
	const { id: userId } = useCurrentUser();
	return useLiveQuery(
		async () =>
			(await db.members.where("groupId").equals(groupId).toArray()).find((m) => m.userId === userId && !m.deletedAt) ??
			null,
		[groupId, userId]
	);
}
