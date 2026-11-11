export type Role = "owner" | "member" | "guest";

export type Category = "food" | "drinks" | "stay" | "travel" | "groceries" | "fun";

export type GroupRow = {
	id: string;
	name: string;
	// The second line on its cover; trimmed, 1 to 120 characters, or null.
	note: string | null;
	// Null once the account that made the group is deleted.
	createdBy: string | null;
	createdAt: string;
	deletedAt: string | null;
	completedAt: string | null;
	completedByMemberId: string | null;
	// The group code without its dash ("HX7K2P"). The server makes it, so it is null until the group has
	// synced, and it stays the old one after a reset until the next pull.
	joinCode: string | null;
	// 0 until the server has accepted the row.
	rowVersion: number;
};

export type MemberRow = {
	id: string;
	groupId: string;
	// Null for a name-only person.
	userId: string | null;
	displayName: string;
	role: Role;
	joinedAt: string | null;
	deletedAt: string | null;
	rowVersion: number;
};

// A bill's line as the device wrote it; paidBy and splitAmong are member ids.
export type Item = { id: string; description?: string; amountCents: number; paidBy: string; splitAmong: string[] };

// owedTo: payer member id -> cents this member owes them from the entry.
export type Share = { memberId: string; paidCents: number; owedCents: number; owedTo: Record<string, number> };

export type PaymentStatus = "pending" | "confirmed" | "declined" | "undone";

export type EntryRow = {
	id: string;
	groupId: string;
	kind: "expense" | "payment";
	description: string;
	amountCents: number;
	// Null for payments.
	items: Item[] | null;
	entryDate: string;
	notes: string | null;
	// Always null for payments.
	category: Category | null;
	// The payment fields are null for bills.
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

// The editable part of a bill: what entry.create carries besides its ids.
export type BillFields = {
	description: string;
	amountCents: number;
	entryDate: string;
	notes: string | null;
	category: Category | null;
	items: Item[];
	shares: Share[];
};

// A bill as a conflict stores it (shares sorted by memberId).
export type EntryVersion = Omit<BillFields, "items"> & { items: Item[] | null; deletedAt: string | null };

export type ConflictResolution = "kept_current" | "took_proposed" | "merged";

export type ConflictRow = {
	id: string;
	groupId: string;
	entryId: string;
	baseVersion: number;
	// Null once the server no longer keeps that version.
	base: (EntryVersion & { rowVersion: number; updatedByMemberId: string }) | null;
	// Null for a delete.
	proposed: EntryVersion | null;
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
	createdBy: string | null;
	createdAt: string;
	expiresAt: string;
	revokedAt: string | null;
	rowVersion: number;
};

// The person owed (from) reminding someone who owes them (to). amountCents is the debt when it was sent.
// Synced to the whole group; screens show it only to its two people.
export type NudgeRow = {
	id: string;
	groupId: string;
	fromMemberId: string;
	toMemberId: string;
	amountCents: number;
	createdAt: string;
	rowVersion: number;
};

// A guest's personal code, for getting back in on another device. Pulled only by the group's owner (every
// guest's) and by that guest (their own). deletedAt is set once they stop being a guest with a login.
export type GuestCodeRow = {
	memberId: string;
	groupId: string;
	code: string;
	createdAt: string;
	deletedAt: string | null;
	rowVersion: number;
};

// Local only: the server keeps just the token's hash.
export type InviteTokenRow = { inviteId: string; groupId: string; token: string };

export type CursorRow = { groupId: string; version: number };

type MutationBody =
	| { type: "group.create"; groupId: string; memberId: string; name: string; displayName: string; note?: string | null }
	| { type: "group.rename"; groupId: string; name: string }
	// note null or blank clears it.
	| { type: "group.describe"; groupId: string; note: string | null }
	| { type: "group.delete"; groupId: string }
	| { type: "group.complete"; groupId: string }
	| { type: "group.reopen"; groupId: string }
	// A new group code, made by the server; the old one stops working.
	| { type: "group.recode"; groupId: string }
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
			expiresAt: string | null;
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
			// Defaults to "Payment".
			description?: string;
	  }
	| { type: "payment.confirm"; groupId: string; entryId: string }
	| { type: "payment.decline"; groupId: string; entryId: string; note: string | null }
	| { type: "payment.undo"; groupId: string; entryId: string }
	| { type: "nudge.send"; groupId: string; nudgeId: string; toMemberId: string; amountCents: number };

// A change made on this device, applied locally at once and queued for push_changes().
// The server reads the same JSON, so field names here are the wire format.
export type Mutation = { id: string; at: string } & MutationBody;
export type MutationType = Mutation["type"];
export type MutationOf<T extends MutationType> = Extract<Mutation, { type: T }>;

// code is the SQLSTATE or HS code push_changes() reports.
export type RejectedMutation = { id: string; code?: string; reason: string };
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
	nudges: NudgeRow[];
	guestCodes: GuestCodeRow[];
};
// movedAway: groups this login lost because its guest name was taken back with the personal code on
// another device. Missing from servers before 012.
export type PullResult = { groupIds: string[]; changes: GroupChanges[]; movedAway?: string[] };
