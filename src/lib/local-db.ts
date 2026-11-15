import Dexie, { type EntityTable } from "dexie";

import type { KeyOf, RowOf, TableName } from "@/lib/sync/tables";
import type { Mutation } from "@/lib/sync/types";

// The account's picture as last set on this device ("" for none); see useMyPicture.
export const MY_PICTURE_KEY = "picture";

export type OutboxEntry = { seq: number; id: string; mutation: Mutation };
type MetaEntry = { key: string; value: string };

type ReplicaTables = { [K in TableName]: EntityTable<RowOf<K>, Extract<KeyOf<K>, keyof RowOf<K>>> };

// The replica's tables come from tables.ts; a new one still needs a version below that creates it.
export interface LocalDb extends ReplicaTables {}

export class LocalDb extends Dexie {
	outbox!: EntityTable<OutboxEntry, "seq">;
	meta!: EntityTable<MetaEntry, "key">;

	constructor(name = "handshake") {
		super(name);
		this.version(1).stores({
			groups: "id",
			members: "id, groupId",
			outbox: "++seq, &id",
			cursors: "groupId",
			meta: "key",
		});
		this.version(2)
			.stores({
				entries: "id, groupId, [groupId+entryDate]",
				conflicts: "id, entryId, groupId",
				invites: "id, groupId",
				inviteTokens: "inviteId, groupId",
			})
			.upgrade(async (tx) => {
				await tx
					.table("groups")
					.toCollection()
					.modify((group: Record<string, unknown>) => {
						delete group.baseCurrency;
						group.completedAt ??= null;
						group.completedByMemberId ??= null;
					});
				await tx
					.table("members")
					.toCollection()
					.modify((member: Record<string, unknown>) => {
						member.joinedAt ??= null;
					});
				// Version 1 never stored entries, conflicts, invites or joinedAt: pull everything again.
				await tx.table("cursors").clear();
			});
		this.version(3)
			.stores({})
			.upgrade(async (tx) => {
				await tx
					.table("groups")
					.toCollection()
					.modify((group: Record<string, unknown>) => {
						group.note ??= null;
					});
				await tx
					.table("entries")
					.toCollection()
					.modify((entry: Record<string, unknown>) => {
						entry.category ??= null;
					});
				// Rows stored before notes and categories: pull everything again to fill them in.
				await tx.table("cursors").clear();
			});
		this.version(4)
			.stores({ nudges: "id, groupId, toMemberId" })
			.upgrade(async (tx) => {
				// Nudges sent before this version: pull everything again to fill the table.
				await tx.table("cursors").clear();
			});
		this.version(5)
			.stores({ guestCodes: "memberId, groupId" })
			.upgrade(async (tx) => {
				await tx
					.table("groups")
					.toCollection()
					.modify((group: Record<string, unknown>) => {
						group.joinCode ??= null;
					});
				// Rows stored before group codes and guest codes: pull everything again to fill them in.
				await tx.table("cursors").clear();
			});
		this.version(6)
			.stores({})
			.upgrade(async (tx) => {
				await tx
					.table("groups")
					.toCollection()
					.modify((group: Record<string, unknown>) => {
						group.coverColor ??= null;
						group.coverSticker ??= null;
					});
				// Groups stored before cover colours and stickers: pull everything again to fill them in.
				await tx.table("cursors").clear();
			});
		// Member rows stored before pictures. Nobody had one then, so there is nothing to pull again.
		this.version(7)
			.stores({})
			.upgrade(async (tx) => {
				await tx
					.table("members")
					.toCollection()
					.modify((member: Record<string, unknown>) => {
						member.picture ??= null;
					});
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
