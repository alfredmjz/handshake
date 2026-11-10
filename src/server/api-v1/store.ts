// The ApiStore seam (docs/architecture.md §9.11): one method per api.v1_* SQL function. Adapters:
// createPostgresApiStore (postgres-store.ts) and createMemoryApiStore (tests/support/memory-api-store.ts),
// both held to tests/api/store.contract.ts.
//
// Every call authenticates tokenHash and counts once against the token's 60-a-minute window (calls
// refused with HS429 don't count), returns only the token owner's data from one snapshot, and throws
// ApiStoreError for an unknown or revoked token (HS401), a group that is unknown, deleted or not the
// owner's (HS404), or too many requests (HS429). Timestamps are as the store has them; the handler
// turns them into ISO strings.

export type MeRow = { userId: string; displayName: string };

export type GroupRowApi = {
	id: string;
	name: string;
	role: "owner" | "member" | "guest";
	memberId: string;
	// The owner's own totals over live bills and payments that count; balance = paid − owed.
	paidCents: number;
	owedCents: number;
	completedAt: string | null;
	updatedAt: string;
};

export type GroupMemberRowApi = {
	memberId: string;
	displayName: string;
	active: boolean;
	paidCents: number;
	owedCents: number;
	// What this member owes each payer, over live bills and payments that count.
	owedTo: Record<string, number>;
};

export type GroupDetailRow = GroupRowApi & { members: GroupMemberRowApi[] };

export type PaymentRowApi = {
	id: string;
	groupId: string;
	groupName: string;
	direction: "sent" | "received";
	counterpartyMemberId: string;
	counterpartyName: string;
	amountCents: number;
	entryDate: string;
	notes: string | null;
	confirmedAt: string;
};

// cursor: group id -> the last version read ({} = from the start).
export type PaymentsQuery = { groupId: string | null; cursor: Record<string, number>; limit: number };

// Payments that count and involve the owner, past the cursor, by group id then feed version then id. A
// page never splits a group version, so it may hold more than `limit`. A fully read group's cursor value
// is its head version. removedGroupIds lists cursor groups the owner can no longer see; they leave the
// cursor.
export type PaymentPageRow = {
	payments: PaymentRowApi[];
	cursor: Record<string, number>;
	hasMore: boolean;
	removedGroupIds: string[];
};

export interface ApiStore {
	me(tokenHash: string): Promise<MeRow>;
	groups(tokenHash: string): Promise<GroupRowApi[]>;
	group(tokenHash: string, groupId: string): Promise<GroupDetailRow>;
	payments(tokenHash: string, query: PaymentsQuery): Promise<PaymentPageRow>;
}

export type ApiStoreErrorCode = "HS401" | "HS404" | "HS429";

export class ApiStoreError extends Error {
	constructor(
		readonly code: ApiStoreErrorCode,
		message: string,
		// HS429 only: whole seconds until the rate window resets.
		readonly retryAfterSeconds: number | null = null
	) {
		super(message);
		this.name = "ApiStoreError";
	}
}
