import { useLiveQuery } from "dexie-react-hooks";

import { db, MY_PICTURE_KEY } from "@/lib/local-db";
import type { MemberRow } from "@/lib/sync/types";
import { byLabel } from "@/lib/utils";

// The order group people are listed in: by name, then id.
export const byMemberName = (a: MemberRow, b: MemberRow) =>
	byLabel(a.displayName, b.displayName) || byLabel(a.id, b.id);

// People in the group by name. includeLeft keeps those who left, for names on old bills and debts.
export function useMembers(groupId: string, { includeLeft = false } = {}) {
	return useLiveQuery(
		async () =>
			(await db.members.where("groupId").equals(groupId).toArray())
				.filter((m) => includeLeft || !m.deletedAt)
				.sort(byMemberName),
		[groupId, includeLeft]
	);
}

// The current user's picture, or null for their drawn face. The server keeps it the same on all their member rows;
// rows in groups they left may be older, so those count only when there are no others. With no rows at all, the
// picture last set on this device.
export function useMyPicture(userId: string): string | null {
	return (
		useLiveQuery(async () => {
			const mine = (await db.members.toArray()).filter((m) => m.userId === userId);
			const current = mine.filter((m) => !m.deletedAt);
			if (mine.length > 0) return (current.length > 0 ? current : mine)[0].picture;
			return (await db.meta.get(MY_PICTURE_KEY))?.value || null;
		}, [userId]) ?? null
	);
}

// Where the current user goes by a name they can change: their member row in each open group, by group name.
export async function myOpenMemberships(userId: string) {
	const mine = (await db.members.toArray()).filter((m) => m.userId === userId && !m.deletedAt);
	const out: { groupId: string; groupName: string; memberId: string; displayName: string }[] = [];
	for (const member of mine) {
		const group = await db.groups.get(member.groupId);
		if (!group || group.deletedAt || group.completedAt) continue;
		out.push({ groupId: group.id, groupName: group.name, memberId: member.id, displayName: member.displayName });
	}
	return out.sort((a, b) => byLabel(a.groupName, b.groupName));
}
