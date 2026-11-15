import type { LocalTables, Rows } from "@/lib/sync/local";
import { rowGroup, rowKey, TABLE_NAMES, type RowOf, type TableName } from "@/lib/sync/tables";
import type { EntryRow, GroupRow, MemberRow, Share } from "@/lib/sync/types";

export type MemoryRows<T> = Rows<T> & { map: Map<string, T> };

export function memoryRows<T>(key: (row: T) => string, groupOf: (row: T) => string): MemoryRows<T> {
	const map = new Map<string, T>();
	return {
		map,
		get: async (id) => map.get(id),
		byGroup: async (groupId) => [...map.values()].filter((row) => groupOf(row) === groupId),
		put: async (rows) => {
			for (const row of rows) map.set(key(row), structuredClone(row));
		},
		delete: async (ids) => {
			for (const id of ids) map.delete(id);
		},
	};
}

type MemoryReplica = { [K in TableName]: MemoryRows<RowOf<K>> };

export function createMemoryTables() {
	const replica = Object.fromEntries(
		TABLE_NAMES.map((name) => [
			name,
			memoryRows<RowOf<typeof name>>(
				(row) => rowKey(name, row),
				(row) => rowGroup(name, row)
			),
		])
	) as MemoryReplica;
	const tables: LocalTables = { ...replica, groupIds: async () => [...replica.groups.map.keys()] };
	return { tables, ...replica };
}

export function serverGroup(overrides: Partial<GroupRow> & Pick<GroupRow, "id">): GroupRow {
	return {
		name: "Trip",
		note: null,
		coverColor: null,
		coverSticker: null,
		createdBy: "user-1",
		createdAt: "2026-11-01T12:00:00.000Z",
		deletedAt: null,
		completedAt: null,
		completedByMemberId: null,
		joinCode: "HX7K2P",
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

export function serverBill(
	overrides: Partial<EntryRow> & Pick<EntryRow, "id" | "groupId" | "createdByMemberId">
): EntryRow {
	const payer = overrides.createdByMemberId;
	const shares: Share[] = [{ memberId: payer, paidCents: 1000, owedCents: 1000, owedTo: { [payer]: 1000 } }];
	return {
		kind: "expense",
		description: "Dinner",
		amountCents: 1000,
		items: [{ id: "i1", amountCents: 1000, paidBy: payer, splitAmong: [payer] }],
		entryDate: "2026-11-01",
		notes: null,
		category: null,
		paymentStatus: null,
		payerConfirmedAt: null,
		receiverConfirmedAt: null,
		confirmedAt: null,
		closedAt: null,
		closeNote: null,
		updatedByMemberId: payer,
		createdAt: "2026-11-01T12:00:00.000Z",
		updatedAt: "2026-11-01T12:00:00.000Z",
		deletedAt: null,
		rowVersion: 1,
		shares,
		...overrides,
	};
}
