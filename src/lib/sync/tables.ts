import type {
	ConflictRow,
	CursorRow,
	EntryRow,
	GroupChanges,
	GroupRow,
	GuestCodeRow,
	InviteRow,
	InviteTokenRow,
	MemberRow,
	NudgeRow,
} from "@/lib/sync/types";

type StringField<Row> = { [F in keyof Row]-?: Row[F] extends string ? F : never }[keyof Row] & string;
type Table<Row, Key extends StringField<Row>> = { row: Row; key: Key };

// The local replica: every table sync reads and writes, with the field that keys its rows.
export type Replica = {
	groups: Table<GroupRow, "id">;
	members: Table<MemberRow, "id">;
	entries: Table<EntryRow, "id">;
	conflicts: Table<ConflictRow, "id">;
	invites: Table<InviteRow, "id">;
	inviteTokens: Table<InviteTokenRow, "inviteId">;
	nudges: Table<NudgeRow, "id">;
	guestCodes: Table<GuestCodeRow, "memberId">;
	cursors: Table<CursorRow, "groupId">;
};

export type TableName = keyof Replica;
export type RowOf<K extends TableName> = Replica[K]["row"];
export type KeyOf<K extends TableName> = Replica[K]["key"];

type Description<T extends Replica[TableName]> = {
	key: T["key"];
	// The field holding the group id: the index byGroup reads.
	group: StringField<T["row"]>;
	// The rows a pull carries for this table; each replaces the local copy.
	pulled?: (change: GroupChanges) => T["row"][];
	// After a full pull (from version 0), the keys this table keeps; "pulled" keeps the rows the pull carried.
	fullPull?: "pulled" | ((change: GroupChanges) => string[]);
};

const TABLES: { [K in TableName]: Description<Replica[K]> } = {
	groups: { key: "id", group: "id", pulled: (c) => c.groups },
	members: { key: "id", group: "groupId", pulled: (c) => c.members, fullPull: "pulled" },
	entries: { key: "id", group: "groupId", pulled: (c) => c.entries, fullPull: "pulled" },
	conflicts: { key: "id", group: "groupId", pulled: (c) => c.conflicts, fullPull: "pulled" },
	invites: { key: "id", group: "groupId", pulled: (c) => c.invites, fullPull: "pulled" },
	// Local only: a link this device made stays as long as the server still has its invite.
	inviteTokens: { key: "inviteId", group: "groupId", fullPull: (c) => c.invites.map((i) => i.id) },
	nudges: { key: "id", group: "groupId", pulled: (c) => c.nudges, fullPull: "pulled" },
	guestCodes: { key: "memberId", group: "groupId", pulled: (c) => c.guestCodes, fullPull: "pulled" },
	// Written by mergePull after each group's rows.
	cursors: { key: "groupId", group: "groupId" },
};

export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

export function groupField<K extends TableName>(name: K): string {
	return TABLES[name].group;
}

export function rowKey<K extends TableName>(name: K, row: RowOf<K>): string {
	return (row as Record<string, string>)[TABLES[name].key];
}

export function rowGroup<K extends TableName>(name: K, row: RowOf<K>): string {
	return (row as Record<string, string>)[TABLES[name].group];
}

export function pulledRows<K extends TableName>(name: K, change: GroupChanges): RowOf<K>[] {
	return TABLES[name].pulled?.(change) ?? [];
}

// null when a full pull leaves the table alone.
export function keptAfterFullPull<K extends TableName>(name: K, change: GroupChanges): Set<string> | null {
	const rule = TABLES[name].fullPull;
	if (!rule) return null;
	if (rule === "pulled") return new Set(pulledRows(name, change).map((row) => rowKey(name, row)));
	return new Set(rule(change));
}
