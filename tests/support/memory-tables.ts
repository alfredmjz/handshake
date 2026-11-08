import type { LocalTables, Rows } from "@/lib/sync/local";
import type {
	ConflictRow,
	CursorRow,
	EntryRow,
	GroupRow,
	InviteRow,
	InviteTokenRow,
	MemberRow,
} from "@/lib/sync/types";

// Rows<T> over a Map, keyed by `key` and grouped by `groupOf`. Rows are copied in and out, as Dexie does.
function memoryRows<T>(key: (row: T) => string, groupOf: (row: T) => string) {
	const map = new Map<string, T>();
	const rows: Rows<T> = {
		get: async (id) => (map.has(id) ? structuredClone(map.get(id)) : undefined),
		byGroup: async (groupId) =>
			[...map.values()].filter((row) => groupOf(row) === groupId).map((row) => structuredClone(row)),
		put: async (list) => {
			for (const row of list) map.set(key(row), structuredClone(row));
		},
		delete: async (ids) => {
			for (const id of ids) map.delete(id);
		},
	};
	return { rows, map };
}

export function createMemoryTables() {
	const groups = memoryRows<GroupRow>(
		(r) => r.id,
		(r) => r.id
	);
	const members = memoryRows<MemberRow>(
		(r) => r.id,
		(r) => r.groupId
	);
	const entries = memoryRows<EntryRow>(
		(r) => r.id,
		(r) => r.groupId
	);
	const conflicts = memoryRows<ConflictRow>(
		(r) => r.id,
		(r) => r.groupId
	);
	const invites = memoryRows<InviteRow>(
		(r) => r.id,
		(r) => r.groupId
	);
	const inviteTokens = memoryRows<InviteTokenRow>(
		(r) => r.inviteId,
		(r) => r.groupId
	);
	const cursors = memoryRows<CursorRow>(
		(r) => r.groupId,
		(r) => r.groupId
	);

	const tables: LocalTables = {
		groups: groups.rows,
		members: members.rows,
		entries: entries.rows,
		conflicts: conflicts.rows,
		invites: invites.rows,
		inviteTokens: inviteTokens.rows,
		cursors: cursors.rows,
		groupIds: async () => [...groups.map.keys()],
	};

	return {
		tables,
		groups: groups.map,
		members: members.map,
		entries: entries.map,
		conflicts: conflicts.map,
		invites: invites.map,
		inviteTokens: inviteTokens.map,
		cursors: cursors.map,
	};
}

export function serverGroup(overrides: Partial<GroupRow> & Pick<GroupRow, "id">): GroupRow {
	return {
		name: "Trip",
		createdBy: "user-1",
		createdAt: "2026-11-01T12:00:00.000Z",
		deletedAt: null,
		completedAt: null,
		completedByMemberId: null,
		rowVersion: 1,
		...overrides,
	};
}

export function serverMember(overrides: Partial<MemberRow> & Pick<MemberRow, "id" | "groupId">): MemberRow {
	return {
		userId: "user-1",
		displayName: "Alex",
		role: "owner",
		joinedAt: "2026-11-01T12:00:00.000Z",
		deletedAt: null,
		rowVersion: 1,
		...overrides,
	};
}

export function serverEntry(overrides: Partial<EntryRow> & Pick<EntryRow, "id" | "groupId">): EntryRow {
	return {
		kind: "expense",
		description: "Dinner",
		amountCents: 1000,
		items: [{ id: "i1", amountCents: 1000, paidBy: "m1", splitAmong: ["m1"] }],
		entryDate: "2026-11-01",
		notes: null,
		paymentStatus: null,
		payerConfirmedAt: null,
		receiverConfirmedAt: null,
		confirmedAt: null,
		closedAt: null,
		closeNote: null,
		createdByMemberId: "m1",
		updatedByMemberId: "m1",
		createdAt: "2026-11-01T12:00:00.000Z",
		updatedAt: "2026-11-01T12:00:00.000Z",
		deletedAt: null,
		rowVersion: 1,
		shares: [{ memberId: "m1", paidCents: 1000, owedCents: 1000, owedTo: { m1: 1000 } }],
		...overrides,
	};
}
