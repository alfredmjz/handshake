import type { LocalDb } from "@/lib/local-db";
import type { SyncStore } from "@/lib/sync/engine";
import { mergePull, type LocalTables } from "@/lib/sync/local";
import type { Mutation } from "@/lib/sync/types";

export function dexieTables(db: LocalDb): LocalTables {
	return {
		getGroup: (id) => db.groups.get(id),
		putGroups: async (rows) => {
			await db.groups.bulkPut(rows);
		},
		putMembers: async (rows) => {
			await db.members.bulkPut(rows);
		},
		setCursor: async (groupId, version) => {
			await db.cursors.put({ groupId, version });
		},
		keepOnlyGroups: async (groupIds) => {
			const keep = new Set(groupIds);
			const gone = (await db.groups.toCollection().primaryKeys()).filter((id) => !keep.has(id));
			if (gone.length === 0) return;
			await db.groups.bulkDelete(gone);
			await db.members.where("groupId").anyOf(gone).delete();
			await db.cursors.bulkDelete(gone);
		},
	};
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
			db.transaction("rw", [db.groups, db.members, db.cursors, db.outbox], async () => {
				await mergePull(dexieTables(db), pull, await pendingMutations(db), userId);
			}),
	};
}
