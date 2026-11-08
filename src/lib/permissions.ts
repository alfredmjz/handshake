// Who may do what: spec decision 8's matrix, the twin of private.may() and
// private.allowed_when_completed() in SQL. tests/fixtures/permission-cases.ts holds the two in step.
// Working out which action an intent is (your own entry or someone else's) is the caller's job.

export type Role = "owner" | "member" | "guest";

export type Action =
	| "group.rename"
	| "group.delete"
	| "group.complete"
	| "group.reopen"
	| "member.add"
	| "member.rename.self"
	| "member.rename.others"
	| "member.remove.self"
	| "member.remove.others"
	| "entry.create"
	| "entry.update"
	| "entry.delete.own"
	| "entry.delete.others"
	| "conflict.resolve"
	| "invite.create"
	| "invite.revoke.own"
	| "invite.revoke.others"
	| "payment.record.own"
	| "payment.record.others"
	| "payment.respond"
	| "payment.undo";

const OWNER: Role[] = ["owner"];
const FULL: Role[] = ["owner", "member"];
const EVERYONE: Role[] = ["owner", "member", "guest"];

const MATRIX: Record<Action, { roles: Role[]; whenCompleted: boolean }> = {
	"group.rename": { roles: OWNER, whenCompleted: false },
	"group.delete": { roles: OWNER, whenCompleted: true },
	"group.complete": { roles: OWNER, whenCompleted: false },
	"group.reopen": { roles: OWNER, whenCompleted: true },
	"member.add": { roles: FULL, whenCompleted: false },
	"member.rename.self": { roles: EVERYONE, whenCompleted: false },
	"member.rename.others": { roles: OWNER, whenCompleted: false },
	"member.remove.self": { roles: EVERYONE, whenCompleted: true },
	"member.remove.others": { roles: OWNER, whenCompleted: false },
	"entry.create": { roles: EVERYONE, whenCompleted: false },
	"entry.update": { roles: FULL, whenCompleted: false },
	"entry.delete.own": { roles: EVERYONE, whenCompleted: false },
	"entry.delete.others": { roles: FULL, whenCompleted: false },
	"conflict.resolve": { roles: FULL, whenCompleted: false },
	"invite.create": { roles: FULL, whenCompleted: false },
	"invite.revoke.own": { roles: FULL, whenCompleted: false },
	"invite.revoke.others": { roles: OWNER, whenCompleted: false },
	"payment.record.own": { roles: EVERYONE, whenCompleted: false },
	"payment.record.others": { roles: FULL, whenCompleted: false },
	"payment.respond": { roles: EVERYONE, whenCompleted: true },
	"payment.undo": { roles: EVERYONE, whenCompleted: false },
};

export function may(action: Action, role: Role): boolean {
	return MATRIX[action]?.roles.includes(role) ?? false;
}

export function allowedWhenCompleted(action: Action): boolean {
	return MATRIX[action]?.whenCompleted ?? false;
}
