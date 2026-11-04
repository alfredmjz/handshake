import type { GroupRow, MemberRow, Mutation, PullResult } from "@/lib/sync/types";

// The local tables sync reads and writes: Dexie in the app, plain maps in tests.
export interface LocalTables {
	getGroup(id: string): Promise<GroupRow | undefined>;
	putGroups(rows: GroupRow[]): Promise<void>;
	putMembers(rows: MemberRow[]): Promise<void>;
	setCursor(groupId: string, version: number): Promise<void>;
	// Drops every other group with its members and cursor.
	keepOnlyGroups(groupIds: string[]): Promise<void>;
}

export async function applyMutation(tables: LocalTables, mutation: Mutation, userId: string): Promise<void> {
	switch (mutation.type) {
		case "group.create": {
			// Once the server's copy has arrived, it wins.
			if (await tables.getGroup(mutation.groupId)) return;
			await tables.putGroups([
				{
					id: mutation.groupId,
					name: mutation.name.trim(),
					baseCurrency: mutation.baseCurrency.toUpperCase(),
					createdBy: userId,
					createdAt: mutation.at,
					deletedAt: null,
					rowVersion: 0,
				},
			]);
			await tables.putMembers([
				{
					id: mutation.memberId,
					groupId: mutation.groupId,
					userId,
					displayName: mutation.displayName,
					role: "owner",
					deletedAt: null,
					rowVersion: 0,
				},
			]);
			return;
		}
		case "group.rename": {
			const group = await tables.getGroup(mutation.groupId);
			if (group) await tables.putGroups([{ ...group, name: mutation.name.trim() }]);
			return;
		}
	}
}

// `pending` must be read in the same transaction as this merge, so changes made while the pull was
// in flight are replayed too.
export async function mergePull(tables: LocalTables, pull: PullResult, pending: Mutation[], userId: string) {
	// Groups created here that haven't reached the server yet are missing from groupIds; keep them.
	const unsynced = pending.flatMap((m) => (m.type === "group.create" ? [m.groupId] : []));
	await tables.keepOnlyGroups([...pull.groupIds, ...unsynced]);

	for (const change of pull.changes) {
		await tables.putGroups(change.groups);
		await tables.putMembers(change.members);
		await tables.setCursor(change.groupId, change.version);
	}

	// Server rows just replaced the local copies; put this device's unsent changes back on top.
	for (const mutation of pending) await applyMutation(tables, mutation, userId);
}
