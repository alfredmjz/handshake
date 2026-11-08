import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@/lib/local-db";

// The people still in the group, by name. Read hooks only.
export function useMembers(groupId: string) {
	return useLiveQuery(
		async () =>
			(
				await db.members
					.where("groupId")
					.equals(groupId)
					.filter((m) => !m.deletedAt)
					.toArray()
			).sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })),
		[groupId]
	);
}

// Everyone who has ever been in the group, people who left included: bills and debts still name them.
export function useAllMembers(groupId: string) {
	return useLiveQuery(() => db.members.where("groupId").equals(groupId).toArray(), [groupId]);
}
