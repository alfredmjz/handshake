import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@/lib/local-db";

// Read hooks only. Links that still work, newest first, each with its token when this device made it.
export function useLiveInvites(groupId: string) {
	return useLiveQuery(async () => {
		const now = new Date().toISOString();
		const invites = await db.invites
			.where("groupId")
			.equals(groupId)
			.filter((invite) => !invite.revokedAt && invite.expiresAt > now)
			.toArray();
		const tokens = await db.inviteTokens.bulkGet(invites.map((invite) => invite.id));
		return invites
			.map((invite, i) => ({ ...invite, token: tokens[i]?.token ?? null }))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}, [groupId]);
}
