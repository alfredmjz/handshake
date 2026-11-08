// Response bodies, written by hand to match docs/api-v1.openapi.yaml (ADR-002). The contract tests hold
// them to it.

export type Me = { userId: string; displayName: string };

export type Group = {
	id: string;
	name: string;
	role: "owner" | "member" | "guest";
	memberId: string;
	balanceCents: number;
	completedAt: string | null;
	updatedAt: string;
};

export type GroupList = { groups: Group[] };

export type Debt = { memberId: string; name: string; direction: "owes_you" | "you_owe"; amountCents: number };

export type GroupDetail = Group & { debts: Debt[] };

export type Payment = {
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

export type PaymentPage = { payments: Payment[]; nextCursor: string; hasMore: boolean; removedGroupIds: string[] };

export type ErrorCode =
	"bad_request" | "invalid_token" | "not_found" | "method_not_allowed" | "rate_limited" | "server_error";

export type ErrorBody = { error: { code: ErrorCode; message: string } };
