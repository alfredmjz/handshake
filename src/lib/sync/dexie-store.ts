import type { Table } from "dexie";

import type { LocalDb } from "@/lib/local-db";
import type { SyncStore } from "@/lib/sync/engine";
import { mergePull, type LocalTables, type Rows } from "@/lib/sync/local";
import type { Mutation } from "@/lib/sync/types";

// `groupIndex` names the index that holds the group id: the primary key for groups and cursors.
function rows<T>(table: Table<T, string, unknown>, groupIndex = "groupId"): Rows<T> {
	return {
		get: (id) => table.get(id),
		byGroup: (groupId) => table.where(groupIndex).equals(groupId).toArray(),
		put: async (list) => {
			if (list.length > 0) await table.bulkPut(list);
		},
		delete: async (ids) => {
			if (ids.length > 0) await table.bulkDelete(ids);
		},
	};
}

export function dexieTables(db: LocalDb): LocalTables {
	return {
		groups: rows(db.groups, "id"),
		members: rows(db.members),
		entries: rows(db.entries),
		conflicts: rows(db.conflicts),
		invites: rows(db.invites),
		inviteTokens: rows(db.inviteTokens),
		cursors: rows(db.cursors),
		groupIds: async () => (await db.groups.toCollection().primaryKeys()) as string[],
	};
}

// Every table a local write touches: the synced rows, the outbox and the cursors.
export function writeTables(db: LocalDb) {
	return [db.groups, db.members, db.entries, db.conflicts, db.invites, db.inviteTokens, db.cursors, db.outbox];
}

async function pendingMutations(db: LocalDb): Promise<Mutation[]> {
	return (await db.outbox.orderBy("seq").toArray()).map((entry) => entry.mutation);
}

export function createDexieSyncStore(db: LocalDb, userId: string): SyncStore {
	return {
		pendingMutations: () => pendingMutations(db),
		removeMutations: async (ids) => {
			await db.outbox.where("id").anyOf(ids).delete();
		},
		cursors: async () => Object.fromEntries((await db.cursors.toArray()).map((c) => [c.groupId, c.version])),
		applyPull: (pull) =>
			db.transaction("rw", writeTables(db), async () => {
				await mergePull(dexieTables(db), pull, await pendingMutations(db), userId);
			}),
	};
}
