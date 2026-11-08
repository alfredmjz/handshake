import type { Item, PaymentStatus, Share } from "@/lib/ledger";
import type { Role } from "@/lib/permissions";

export type GroupRow = {
	id: string;
	name: string;
	// Null once the person who made it has deleted their account.
	createdBy: string | null;
	createdAt: string;
	deletedAt: string | null;
	completedAt: string | null;
	completedByMemberId: string | null;
	// 0 until the server has accepted the row.
	rowVersion: number;
};

export type MemberRow = {
	id: string;
	groupId: string;
	// Null for a name-only person: added by name and not joined, or whose login is gone.
	userId: string | null;
	displayName: string;
	role: Role;
	joinedAt: string | null;
	deletedAt: string | null;
	rowVersion: number;
};

export type EntryRow = {
	id: string;
	groupId: string;
	kind: "expense" | "payment";
	description: string;
	amountCents: number;
	// Bills only: the items as the editor wrote them.
	items: Item[] | null;
	entryDate: string;
	notes: string | null;
	// Payments only: the handshake (spec decision 17).
	paymentStatus: PaymentStatus | null;
	payerConfirmedAt: string | null;
	receiverConfirmedAt: string | null;
	confirmedAt: string | null;
	closedAt: string | null;
	closeNote: string | null;
	createdByMemberId: string;
	updatedByMemberId: string;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	rowVersion: number;
	shares: Share[];
};

// The bill fields of entry.create, entry.update and a resolution's final version.
export type BillFields = {
	description: string;
	amountCents: number;
	entryDate: string;
	notes: string | null;
	items: Item[];
	shares: Share[];
};

// A bill as the server stored it at one version (architecture §11.1).
export type EntrySnapshot = {
	description: string;
	amountCents: number;
	entryDate: string;
	notes: string | null;
	items: Item[] | null;
	shares: Share[];
	deletedAt: string | null;
	rowVersion?: number;
	updatedByMemberId?: string;
};

export type ConflictResolution = "kept_current" | "took_proposed" | "merged";

export type ConflictRow = {
	id: string;
	groupId: string;
	entryId: string;
	baseVersion: number;
	// Null once the server no longer keeps that version.
	base: EntrySnapshot | null;
	// Null for a delete.
	proposed: EntrySnapshot | null;
	proposedByMemberId: string;
	createdAt: string;
	resolvedAt: string | null;
	resolvedByMemberId: string | null;
	resolution: ConflictResolution | null;
	rowVersion: number;
};

export type InviteRow = {
	id: string;
	groupId: string;
	claimMemberId: string | null;
	// Null once the person who made it has deleted their account.
	createdBy: string | null;
	createdAt: string;
	expiresAt: string;
	revokedAt: string | null;
	rowVersion: number;
};

// Local only: the creator's device keeps the token so it can share the link again.
export type InviteTokenRow = { inviteId: string; groupId: string; token: string };

export type CursorRow = { groupId: string; version: number };

// A change made on this device, applied locally at once and queued for push_changes().
// The server reads the same JSON, so field names here are the wire format.
export type Mutation = { id: string; at: string } & (
	| { type: "group.create"; groupId: string; memberId: string; name: string; displayName: string }
	| { type: "group.rename"; groupId: string; name: string }
	| { type: "group.delete"; groupId: string }
	| { type: "group.complete"; groupId: string }
	| { type: "group.reopen"; groupId: string }
	| { type: "member.add"; groupId: string; memberId: string; displayName: string }
	| { type: "member.rename"; groupId: string; memberId: string; displayName: string }
	| { type: "member.remove"; groupId: string; memberId: string }
	| ({ type: "entry.create"; groupId: string; entryId: string } & BillFields)
	| ({ type: "entry.update"; groupId: string; entryId: string; baseVersion: number } & BillFields)
	| { type: "entry.delete"; groupId: string; entryId: string; baseVersion: number }
	| {
			type: "conflict.resolve";
			groupId: string;
			conflictId: string;
			entryId: string;
			resolution: ConflictResolution;
			entry: BillFields | { deleted: true };
	  }
	| {
			type: "invite.create";
			groupId: string;
			inviteId: string;
			token: string;
			claimMemberId: string | null;
			expiresAt: string;
	  }
	| { type: "invite.revoke"; groupId: string; inviteId: string }
	| {
			type: "payment.record";
			groupId: string;
			entryId: string;
			fromMemberId: string;
			toMemberId: string;
			amountCents: number;
			entryDate: string;
			notes: string | null;
	  }
	| { type: "payment.confirm"; groupId: string; entryId: string }
	| { type: "payment.decline"; groupId: string; entryId: string; note: string | null }
	| { type: "payment.undo"; groupId: string; entryId: string }
);

// code is the SQLSTATE: HS403, HS404, HS409, HS422, or one passed through such as 23505.
export type RejectedMutation = { id: string; code: string; reason: string };
export type PushResult = { applied: string[]; rejected: RejectedMutation[] };

// Group id -> the last version this device has of that group.
export type Cursors = Record<string, number>;

export type GroupChanges = {
	groupId: string;
	version: number;
	groups: GroupRow[];
	members: MemberRow[];
	entries: EntryRow[];
	conflicts: ConflictRow[];
	invites: InviteRow[];
};
export type PullResult = { groupIds: string[]; changes: GroupChanges[] };
