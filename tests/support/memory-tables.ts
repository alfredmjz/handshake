import type { LocalTables, Rows } from "@/lib/sync/local";
import type {
	ConflictRow,
	CursorRow,
	EntryRow,
	GroupRow,
	InviteRow,
	InviteTokenRow,
	MemberRow,
	NudgeRow,
	Share,
} from "@/lib/sync/types";

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
	const nudges = memoryRows<NudgeRow>(
		(r) => r.id,
		(r) => r.groupId
	);
	const cursors = memoryRows<CursorRow>(
		(r) => r.groupId,
		(r) => r.groupId
	);

	const tables: LocalTables = {
		groups,
		members,
		entries,
		conflicts,
		invites,
		inviteTokens,
		nudges,
		cursors,
		groupIds: async () => [...groups.map.keys()],
	};

	return { tables, groups, members, entries, conflicts, invites, inviteTokens, nudges, cursors };
}

export function serverGroup(overrides: Partial<GroupRow> & Pick<GroupRow, "id">): GroupRow {
	return {
		name: "Trip",
		note: null,
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
