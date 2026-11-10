import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@/lib/local-db";

// Links not revoked (expired ones included, so the screen can show the date), newest first.
export function useInvites(groupId: string) {
	return useLiveQuery(
		async () =>
			(await db.invites.where("groupId").equals(groupId).toArray())
				.filter((i) => !i.revokedAt)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
		[groupId]
	);
}

// The token this device made for the link: undefined while loading, null when it was made elsewhere.
export function useInviteToken(inviteId: string) {
	return useLiveQuery(async () => (await db.inviteTokens.get(inviteId))?.token ?? null, [inviteId]);
}
