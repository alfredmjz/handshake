export type GroupRow = {
	id: string;
	name: string;
	baseCurrency: string;
	createdBy: string;
	createdAt: string;
	deletedAt: string | null;
	// 0 until the server has accepted the row.
	rowVersion: number;
};

export type MemberRow = {
	id: string;
	groupId: string;
	userId: string | null;
	displayName: string;
	role: "owner" | "member";
	deletedAt: string | null;
	rowVersion: number;
};

// A change made on this device, applied locally at once and queued for push_changes().
// The server reads the same JSON, so field names here are the wire format.
export type Mutation = { id: string; at: string } & (
	| {
			type: "group.create";
			groupId: string;
			memberId: string;
			name: string;
			baseCurrency: string;
			displayName: string;
	  }
	| { type: "group.rename"; groupId: string; name: string }
);

export type RejectedMutation = { id: string; reason: string };
export type PushResult = { applied: string[]; rejected: RejectedMutation[] };

// Group id -> the last version this device has of that group.
export type Cursors = Record<string, number>;

export type GroupChanges = { groupId: string; version: number; groups: GroupRow[]; members: MemberRow[] };
export type PullResult = { groupIds: string[]; changes: GroupChanges[] };
