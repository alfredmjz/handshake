import Dexie, { type DexieOptions, type EntityTable } from "dexie";

import type {
	ConflictRow,
	CursorRow,
	EntryRow,
	GroupRow,
	InviteRow,
	InviteTokenRow,
	MemberRow,
	Mutation,
} from "@/lib/sync/types";

export type OutboxEntry = { seq: number; id: string; mutation: Mutation };
type MetaEntry = { key: string; value: string };

export class LocalDb extends Dexie {
	groups!: EntityTable<GroupRow, "id">;
	members!: EntityTable<MemberRow, "id">;
	entries!: EntityTable<EntryRow, "id">;
	conflicts!: EntityTable<ConflictRow, "id">;
	invites!: EntityTable<InviteRow, "id">;
	inviteTokens!: EntityTable<InviteTokenRow, "inviteId">;
	outbox!: EntityTable<OutboxEntry, "seq">;
	cursors!: EntityTable<CursorRow, "groupId">;
	meta!: EntityTable<MetaEntry, "key">;

	// Tests pass fake-indexeddb in `options`.
	constructor(name = "handshake", options?: DexieOptions) {
		super(name, options);
		this.version(1).stores({
			groups: "id",
			members: "id, groupId",
			outbox: "++seq, &id",
			cursors: "groupId",
			meta: "key",
		});
		this.version(2)
			.stores({
				groups: "id",
				members: "id, groupId",
				entries: "id, groupId, [groupId+entryDate]",
				conflicts: "id, entryId, groupId",
				invites: "id, groupId",
				inviteTokens: "inviteId, groupId",
				outbox: "++seq, &id",
				cursors: "groupId",
				meta: "key",
			})
			.upgrade(async (tx) => {
				// Version 1 rows lack the new columns, and its cursors predate entries, conflicts and invites:
				// starting the cursors again makes the next pull send every group whole.
				await tx.table("cursors").clear();
				await tx
					.table("groups")
					.toCollection()
					.modify((group: GroupRow & { baseCurrency?: string }) => {
						delete group.baseCurrency;
						group.completedAt ??= null;
						group.completedByMemberId ??= null;
					});
				await tx
					.table("members")
					.toCollection()
					.modify((member: MemberRow) => {
						member.joinedAt ??= null;
					});
			});
	}
}

export const db = new LocalDb();

export async function clearLocalData(database: LocalDb = db) {
	await database.transaction("rw", database.tables, () => Promise.all(database.tables.map((table) => table.clear())));
}

// Local data belongs to one account; another account signing in on this device starts clean.
export async function claimLocalData(userId: string) {
	const owner = await db.meta.get("userId");
	if (owner?.value === userId) return;
	await clearLocalData();
	await db.meta.put({ key: "userId", value: userId });
}
