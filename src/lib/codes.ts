import { useLiveQuery } from "dexie-react-hooks";

import { useCurrentUser } from "@/lib/auth";
import { db } from "@/lib/local-db";
import { readMovedAwayNotices, writeMovedAwayNotices } from "@/lib/sync/dexie-store";

// The group's code (stored form, "HX7K2P"; show it with formatCode): undefined while loading, null when the
// group hasn't synced yet (or this device doesn't have it).
export function useGroupCode(groupId: string) {
	return useLiveQuery(async () => (await db.groups.get(groupId))?.joinCode ?? null, [groupId]);
}

// For the owner: member id → personal code of each guest in the group. Other members' devices never receive
// codes, so for them it is empty. undefined while loading.
export function useGuestCodes(groupId: string) {
	return useLiveQuery(async () => {
		const codes = await db.guestCodes.where("groupId").equals(groupId).toArray();
		return new Map(codes.filter((c) => !c.deletedAt).map((c) => [c.memberId, c.code]));
	}, [groupId]);
}

// The current user's personal code in the group: undefined while loading, null when they have none (not a
// guest, or not synced yet).
export function useMyGuestCode(groupId: string) {
	const { id: userId } = useCurrentUser();
	return useLiveQuery(async () => {
		const mine = (await db.members.where("groupId").equals(groupId).toArray()).find(
			(m) => m.userId === userId && !m.deletedAt
		);
		if (!mine) return null;
		const code = await db.guestCodes.get(mine.id);
		return code && !code.deletedAt ? code.code : null;
	}, [groupId, userId]);
}

// Groups this device lost because the guest's name was taken back on another device, each once:
// "<displayName> is now signed in on another device" (in groupName). [] while loading.
export function useMovedAwayNotices() {
	return useLiveQuery(() => readMovedAwayNotices(db), [], []);
}

export async function dismissMovedAwayNotice(groupId: string) {
	await db.transaction("rw", db.meta, async () => {
		await writeMovedAwayNotices(
			db,
			(await readMovedAwayNotices(db)).filter((n) => n.groupId !== groupId)
		);
	});
}
