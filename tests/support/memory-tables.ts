import type { LocalTables } from "@/lib/sync/local";
import type { GroupRow, MemberRow } from "@/lib/sync/types";

export function createMemoryTables() {
	const groups = new Map<string, GroupRow>();
	const members = new Map<string, MemberRow>();
	const cursors = new Map<string, number>();

	const tables: LocalTables = {
		getGroup: async (id) => groups.get(id),
		putGroups: async (rows) => {
			for (const row of rows) groups.set(row.id, row);
		},
		putMembers: async (rows) => {
			for (const row of rows) members.set(row.id, row);
		},
		setCursor: async (groupId, version) => {
			cursors.set(groupId, version);
		},
		keepOnlyGroups: async (groupIds) => {
			const keep = new Set(groupIds);
			for (const id of [...groups.keys()]) {
				if (keep.has(id)) continue;
				groups.delete(id);
				cursors.delete(id);
				for (const [memberId, member] of members) if (member.groupId === id) members.delete(memberId);
			}
		},
	};

	return { tables, groups, members, cursors };
}

export function serverGroup(overrides: Partial<GroupRow> & Pick<GroupRow, "id">): GroupRow {
	return {
		name: "Trip",
		baseCurrency: "CAD",
		createdBy: "user-1",
		createdAt: "2026-11-01T12:00:00.000Z",
		deletedAt: null,
		rowVersion: 1,
		...overrides,
	};
}

export function serverMember(overrides: Partial<MemberRow> & Pick<MemberRow, "id" | "groupId">): MemberRow {
	return { userId: "user-1", displayName: "Alex", role: "owner", deletedAt: null, rowVersion: 1, ...overrides };
}
