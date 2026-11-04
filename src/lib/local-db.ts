import Dexie, { type EntityTable } from "dexie";

import type { GroupRow, MemberRow, Mutation } from "@/lib/sync/types";

export type OutboxEntry = { seq: number; id: string; mutation: Mutation };
export type CursorEntry = { groupId: string; version: number };
type MetaEntry = { key: string; value: string };

export class LocalDb extends Dexie {
	groups!: EntityTable<GroupRow, "id">;
	members!: EntityTable<MemberRow, "id">;
	outbox!: EntityTable<OutboxEntry, "seq">;
	cursors!: EntityTable<CursorEntry, "groupId">;
	meta!: EntityTable<MetaEntry, "key">;

	constructor() {
		super("handshake");
		this.version(1).stores({
			groups: "id",
			members: "id, groupId",
			outbox: "++seq, &id",
			cursors: "groupId",
			meta: "key",
		});
	}
}

export const db = new LocalDb();

export async function clearLocalData() {
	await db.transaction("rw", db.tables, () => Promise.all(db.tables.map((table) => table.clear())));
}

// Local data belongs to one account; another account signing in on this device starts clean.
export async function claimLocalData(userId: string) {
	const owner = await db.meta.get("userId");
	if (owner?.value === userId) return;
	await clearLocalData();
	await db.meta.put({ key: "userId", value: userId });
}
