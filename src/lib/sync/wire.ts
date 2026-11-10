import type {
	ConflictRow,
	EntryRow,
	EntryVersion,
	GroupChanges,
	GroupRow,
	InviteRow,
	MemberRow,
	PullResult,
	Share,
} from "@/lib/sync/types";

// pull_changes() rows as supabase/migrations/010_categories_notes.sql builds them.
export type RawGroup = {
	id: string;
	name: string;
	note: string | null;
	base_currency: string;
	created_by: string | null;
	created_at: string;
	deleted_at: string | null;
	completed_at: string | null;
	completed_by_member_id: string | null;
	row_version: number;
};

export type RawMember = {
	id: string;
	group_id: string;
	user_id: string | null;
	display_name: string;
	role: MemberRow["role"];
	joined_at: string | null;
	deleted_at: string | null;
	row_version: number;
};

export type RawShare = { member_id: string; paid_cents: number; owed_cents: number; owed_to: Record<string, number> };

export type RawEntry = {
	id: string;
	group_id: string;
	kind: EntryRow["kind"];
	description: string;
	amount_cents: number;
	// Stored as the device sent it, so already camelCase.
	items: EntryRow["items"];
	entry_date: string;
	notes: string | null;
	category: EntryRow["category"];
	payment_status: EntryRow["paymentStatus"];
	payer_confirmed_at: string | null;
	receiver_confirmed_at: string | null;
	confirmed_at: string | null;
	closed_at: string | null;
	close_note: string | null;
	created_by_member_id: string;
	updated_by_member_id: string;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
	row_version: number;
	shares: RawShare[];
};

export type RawConflict = {
	id: string;
	group_id: string;
	entry_id: string;
	base_version: number;
	// Built in camelCase by the server.
	base: ConflictRow["base"];
	proposed: ConflictRow["proposed"];
	proposed_by_member_id: string;
	created_at: string;
	resolved_at: string | null;
	resolved_by_member_id: string | null;
	resolution: ConflictRow["resolution"];
	row_version: number;
};

export type RawInvite = {
	id: string;
	group_id: string;
	claim_member_id: string | null;
	created_by: string | null;
	created_at: string;
	expires_at: string;
	revoked_at: string | null;
	row_version: number;
};

export type RawGroupChanges = {
	group_id: string;
	version: number;
	groups: RawGroup[];
	members: RawMember[];
	entries: RawEntry[];
	conflicts: RawConflict[];
	invites: RawInvite[];
};

export type RawPull = { group_ids: string[]; changes: RawGroupChanges[] };

// base_currency is not kept on the device (dollars only).
export function toGroupRow(raw: RawGroup): GroupRow {
	return {
		id: raw.id,
		name: raw.name,
		note: raw.note ?? null,
		createdBy: raw.created_by,
		createdAt: raw.created_at,
		deletedAt: raw.deleted_at,
		completedAt: raw.completed_at,
		completedByMemberId: raw.completed_by_member_id,
		rowVersion: raw.row_version,
	};
}

export function toMemberRow(raw: RawMember): MemberRow {
	return {
		id: raw.id,
		groupId: raw.group_id,
		userId: raw.user_id,
		displayName: raw.display_name,
		role: raw.role,
		joinedAt: raw.joined_at,
		deletedAt: raw.deleted_at,
		rowVersion: raw.row_version,
	};
}

function toShare(raw: RawShare): Share {
	return { memberId: raw.member_id, paidCents: raw.paid_cents, owedCents: raw.owed_cents, owedTo: raw.owed_to };
}

export function toEntryRow(raw: RawEntry): EntryRow {
	return {
		id: raw.id,
		groupId: raw.group_id,
		kind: raw.kind,
		description: raw.description,
		amountCents: raw.amount_cents,
		items: raw.items,
		entryDate: raw.entry_date,
		notes: raw.notes,
		category: raw.category ?? null,
		paymentStatus: raw.payment_status,
		payerConfirmedAt: raw.payer_confirmed_at,
		receiverConfirmedAt: raw.receiver_confirmed_at,
		confirmedAt: raw.confirmed_at,
		closedAt: raw.closed_at,
		closeNote: raw.close_note,
		createdByMemberId: raw.created_by_member_id,
		updatedByMemberId: raw.updated_by_member_id,
		createdAt: raw.created_at,
		updatedAt: raw.updated_at,
		deletedAt: raw.deleted_at,
		rowVersion: raw.row_version,
		shares: raw.shares.map(toShare),
	};
}

// Snapshots written before 010 have no category: none.
function withCategory<T extends EntryVersion>(version: T | null): T | null {
	return version && { ...version, category: version.category ?? null };
}

export function toConflictRow(raw: RawConflict): ConflictRow {
	return {
		id: raw.id,
		groupId: raw.group_id,
		entryId: raw.entry_id,
		baseVersion: raw.base_version,
		base: withCategory(raw.base),
		proposed: withCategory(raw.proposed),
		proposedByMemberId: raw.proposed_by_member_id,
		createdAt: raw.created_at,
		resolvedAt: raw.resolved_at,
		resolvedByMemberId: raw.resolved_by_member_id,
		resolution: raw.resolution,
		rowVersion: raw.row_version,
	};
}

export function toInviteRow(raw: RawInvite): InviteRow {
	return {
		id: raw.id,
		groupId: raw.group_id,
		claimMemberId: raw.claim_member_id,
		createdBy: raw.created_by,
		createdAt: raw.created_at,
		expiresAt: raw.expires_at,
		revokedAt: raw.revoked_at,
		rowVersion: raw.row_version,
	};
}

function toGroupChanges(raw: RawGroupChanges): GroupChanges {
	return {
		groupId: raw.group_id,
		version: raw.version,
		groups: raw.groups.map(toGroupRow),
		members: raw.members.map(toMemberRow),
		entries: raw.entries.map(toEntryRow),
		conflicts: raw.conflicts.map(toConflictRow),
		invites: raw.invites.map(toInviteRow),
	};
}

export function toPullResult(raw: RawPull): PullResult {
	return { groupIds: raw.group_ids, changes: raw.changes.map(toGroupChanges) };
}
