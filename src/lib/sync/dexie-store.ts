import type { Table } from "dexie";

import type { LocalDb } from "@/lib/local-db";
import type { SyncStore } from "@/lib/sync/engine";
import { mergePull, type LocalTables, type Rows } from "@/lib/sync/local";
import type { Mutation } from "@/lib/sync/types";

// groupIndex names the field that holds the group id (the primary key itself for groups and cursors).
function rows<T>(table: Table<T, string, unknown>, groupIndex: string): Rows<T> {
	return {
		get: (id) => table.get(id),
		byGroup: (groupId) => table.where(groupIndex).equals(groupId).toArray(),
		put: async (list) => {
			await table.bulkPut(list);
		},
		delete: (ids) => table.bulkDelete(ids),
	};
}

export function dexieTables(db: LocalDb): LocalTables {
	return {
		groups: rows(db.groups, "id"),
		members: rows(db.members, "groupId"),
		entries: rows(db.entries, "groupId"),
		conflicts: rows(db.conflicts, "groupId"),
		invites: rows(db.invites, "groupId"),
		inviteTokens: rows(db.inviteTokens, "groupId"),
		nudges: rows(db.nudges, "groupId"),
		cursors: rows(db.cursors, "groupId"),
		groupIds: () => db.groups.toCollection().primaryKeys(),
	};
}

// Every table a local write touches: the replica's tables plus the outbox. A read-write transaction over
// these can run applyMutation or mergePull and queue mutations.
export function writeTables(db: LocalDb) {
	return [
		db.groups,
		db.members,
		db.entries,
		db.conflicts,
		db.invites,
		db.inviteTokens,
		db.nudges,
		db.cursors,
		db.outbox,
	];
}

// The next pull then sends every group whole, and mergePull drops what the server doesn't have: how the
// device sheds the local effects of rejected changes.
export async function resetCursors(db: LocalDb) {
	await db.cursors.clear();
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
