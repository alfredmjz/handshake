import type { GroupRow, MemberRow, PullResult } from "@/lib/sync/types";

type RawGroup = {
	id: string;
	name: string;
	base_currency: string;
	created_by: string;
	created_at: string;
	deleted_at: string | null;
	row_version: number;
};

type RawMember = {
	id: string;
	group_id: string;
	user_id: string | null;
	display_name: string;
	role: "owner" | "member";
	deleted_at: string | null;
	row_version: number;
};

export type RawPull = {
	group_ids: string[];
	changes: { group_id: string; version: number; groups: RawGroup[]; members: RawMember[] }[];
};

function toGroupRow(raw: RawGroup): GroupRow {
	return {
		id: raw.id,
		name: raw.name,
		baseCurrency: raw.base_currency,
		createdBy: raw.created_by,
		createdAt: raw.created_at,
		deletedAt: raw.deleted_at,
		rowVersion: raw.row_version,
	};
}

function toMemberRow(raw: RawMember): MemberRow {
	return {
		id: raw.id,
		groupId: raw.group_id,
		userId: raw.user_id,
		displayName: raw.display_name,
		role: raw.role,
		deletedAt: raw.deleted_at,
		rowVersion: raw.row_version,
	};
}

export function toPullResult(raw: RawPull): PullResult {
	return {
		groupIds: raw.group_ids,
		changes: raw.changes.map((change) => ({
			groupId: change.group_id,
			version: change.version,
			groups: change.groups.map(toGroupRow),
			members: change.members.map(toMemberRow),
		})),
	};
}
