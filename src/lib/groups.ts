import { useLiveQuery } from "dexie-react-hooks";

import { defaultDisplayName, type CurrentUser } from "@/lib/auth";
import { newId } from "@/lib/ids";
import { db } from "@/lib/local-db";
import { mutate } from "@/lib/sync/mutate";

export const DEFAULT_CURRENCY = "CAD";

const byName = (a: { name: string }, b: { name: string }) =>
	a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export function useGroups() {
	return useLiveQuery(async () => (await db.groups.filter((g) => !g.deletedAt).toArray()).sort(byName));
}

// undefined while loading, null when this device doesn't have the group.
export function useGroup(groupId: string) {
	return useLiveQuery(async () => (await db.groups.get(groupId)) ?? null, [groupId]);
}

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

export function useWaitingChanges() {
	return useLiveQuery(() => db.outbox.count(), [], 0);
}

export async function createGroup(user: CurrentUser, name: string, baseCurrency = DEFAULT_CURRENCY) {
	const groupId = newId();
	await mutate(
		{
			id: newId(),
			at: new Date().toISOString(),
			type: "group.create",
			groupId,
			memberId: newId(),
			name,
			baseCurrency,
			displayName: defaultDisplayName(user.email),
		},
		user.id
	);
	return groupId;
}

export async function renameGroup(user: CurrentUser, groupId: string, name: string) {
	await mutate({ id: newId(), at: new Date().toISOString(), type: "group.rename", groupId, name }, user.id);
}
