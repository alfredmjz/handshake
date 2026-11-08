import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@/lib/local-db";

// Read hooks only; changes go through commit(intent) (src/lib/changes.ts).

const byName = (a: { name: string }, b: { name: string }) =>
	a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export function useGroups() {
	return useLiveQuery(async () => (await db.groups.filter((g) => !g.deletedAt).toArray()).sort(byName));
}

// undefined while loading, null when this device doesn't have the group.
export function useGroup(groupId: string) {
	return useLiveQuery(async () => (await db.groups.get(groupId)) ?? null, [groupId]);
}

export function useWaitingChanges() {
	return useLiveQuery(() => db.outbox.count(), [], 0);
}
