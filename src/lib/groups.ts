import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@/lib/local-db";
import type { Mutation } from "@/lib/sync/types";

export const byLabel = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

// Groups this device has, not deleted, by name.
export function useGroups() {
	return useLiveQuery(async () =>
		(await db.groups.filter((g) => !g.deletedAt).toArray()).sort(
			(a, b) => byLabel(a.name, b.name) || byLabel(a.id, b.id)
		)
	);
}

// undefined while loading, null when this device doesn't have the group.
export function useGroup(groupId: string) {
	return useLiveQuery(async () => (await db.groups.get(groupId)) ?? null, [groupId]);
}

export function useWaitingChanges() {
	return useLiveQuery(() => db.outbox.count(), [], 0);
}

// The row a mutation writes: what shows "Not synced yet" while it waits in the outbox.
function rowIds(m: Mutation): string[] {
	switch (m.type) {
		case "group.create":
			return [m.groupId, m.memberId];
		case "group.rename":
		case "group.describe":
		case "group.delete":
		case "group.complete":
		case "group.reopen":
		case "group.recode":
			return [m.groupId];
		case "member.add":
		case "member.rename":
		case "member.remove":
			return [m.memberId];
		case "conflict.resolve":
			return [m.conflictId, m.entryId];
		case "invite.create":
		case "invite.revoke":
			return [m.inviteId];
		case "nudge.send":
			return [m.nudgeId];
		default:
			return [m.entryId];
	}
}

// Ids of groups, people, entries, conflicts, invites and nudges with a change not yet accepted by the server.
export function useUnsyncedIds() {
	return useLiveQuery(async () => new Set((await db.outbox.toArray()).flatMap((e) => rowIds(e.mutation))));
}
