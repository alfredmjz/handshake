import type { Item, PaymentStatus } from "@/lib/ledger";
import type { Role } from "@/lib/permissions";
import type {
	ConflictResolution,
	ConflictRow,
	EntryRow,
	EntrySnapshot,
	GroupRow,
	InviteRow,
	MemberRow,
	PullResult,
} from "@/lib/sync/types";

// pull_changes() rows, snake_case, with exactly the keys in docs/architecture.md §11.2. Timestamps and
// dates arrive as Postgres's JSON text and are kept as they are.

type RawGroup = {
	id: string;
	name: string;
	base_currency: string;
	created_by: string | null;
	created_at: string;
	deleted_at: string | null;
	completed_at: string | null;
	completed_by_member_id: string | null;
	row_version: number;
};

type RawMember = {
	id: string;
	group_id: string;
	user_id: string | null;
	display_name: string;
	role: Role;
	joined_at: string | null;
	deleted_at: string | null;
	row_version: number;
};

type RawShare = { member_id: string; paid_cents: number; owed_cents: number; owed_to: Record<string, number> };

type RawEntry = {
	id: string;
	group_id: string;
	kind: "expense" | "payment";
	description: string;
	amount_cents: number;
	items: Item[] | null;
	entry_date: string;
	notes: string | null;
	payment_status: PaymentStatus | null;
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

type RawConflict = {
	id: string;
	group_id: string;
	entry_id: string;
	base_version: number;
	// Stored camelCase, as the device wrote it (§11.1).
	base: EntrySnapshot | null;
	proposed: EntrySnapshot | null;
	proposed_by_member_id: string;
	created_at: string;
	resolved_at: string | null;
	resolved_by_member_id: string | null;
	resolution: ConflictResolution | null;
	row_version: number;
};

type RawInvite = {
	id: string;
	group_id: string;
	claim_member_id: string | null;
	created_by: string | null;
	created_at: string;
	expires_at: string;
	revoked_at: string | null;
	row_version: number;
};

export type RawPull = {
	group_ids: string[];
	changes: {
		group_id: string;
		version: number;
		groups: RawGroup[];
		members: RawMember[];
		entries: RawEntry[];
		conflicts: RawConflict[];
		invites: RawInvite[];
	}[];
};

function toGroupRow(raw: RawGroup): GroupRow {
	return {
		id: raw.id,
		name: raw.name,
		createdBy: raw.created_by,
		createdAt: raw.created_at,
		deletedAt: raw.deleted_at,
		completedAt: raw.completed_at,
		completedByMemberId: raw.completed_by_member_id,
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
		joinedAt: raw.joined_at,
		deletedAt: raw.deleted_at,
		rowVersion: raw.row_version,
	};
}

function toEntryRow(raw: RawEntry): EntryRow {
	return {
		id: raw.id,
		groupId: raw.group_id,
		kind: raw.kind,
		description: raw.description,
		amountCents: raw.amount_cents,
		items: raw.items,
		entryDate: raw.entry_date,
		notes: raw.notes,
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
		shares: raw.shares.map((share) => ({
			memberId: share.member_id,
			paidCents: share.paid_cents,
			owedCents: share.owed_cents,
			owedTo: share.owed_to,
		})),
	};
}

function toConflictRow(raw: RawConflict): ConflictRow {
	return {
		id: raw.id,
		groupId: raw.group_id,
		entryId: raw.entry_id,
		baseVersion: raw.base_version,
		base: raw.base,
		proposed: raw.proposed,
		proposedByMemberId: raw.proposed_by_member_id,
		createdAt: raw.created_at,
		resolvedAt: raw.resolved_at,
		resolvedByMemberId: raw.resolved_by_member_id,
		resolution: raw.resolution,
		rowVersion: raw.row_version,
	};
}

function toInviteRow(raw: RawInvite): InviteRow {
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

export function toPullResult(raw: RawPull): PullResult {
	return {
		groupIds: raw.group_ids,
		changes: raw.changes.map((change) => ({
			groupId: change.group_id,
			version: change.version,
			groups: change.groups.map(toGroupRow),
			members: change.members.map(toMemberRow),
			entries: change.entries.map(toEntryRow),
			conflicts: change.conflicts.map(toConflictRow),
			invites: change.invites.map(toInviteRow),
		})),
	};
}
