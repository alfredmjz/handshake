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
	| "payment.undo"
	| "nudge.send";

const ALLOWED: Record<Action, readonly Role[]> = {
	"group.rename": ["owner"],
	"group.delete": ["owner"],
	"group.complete": ["owner"],
	"group.reopen": ["owner"],
	"member.add": ["owner", "member"],
	"member.rename.self": ["owner", "member", "guest"],
	"member.rename.others": ["owner"],
	"member.remove.self": ["owner", "member", "guest"],
	"member.remove.others": ["owner"],
	"entry.create": ["owner", "member", "guest"],
	"entry.update": ["owner", "member"],
	"entry.delete.own": ["owner", "member", "guest"],
	"entry.delete.others": ["owner", "member"],
	"conflict.resolve": ["owner", "member"],
	"invite.create": ["owner", "member"],
	"invite.revoke.own": ["owner", "member"],
	"invite.revoke.others": ["owner"],
	"payment.record.own": ["owner", "member", "guest"],
	"payment.record.others": ["owner", "member"],
	"payment.respond": ["owner", "member", "guest"],
	"payment.undo": ["owner", "member", "guest"],
	"nudge.send": ["owner", "member", "guest"],
};

const WHEN_COMPLETED: ReadonlySet<Action> = new Set<Action>([
	"group.delete",
	"group.reopen",
	"member.remove.self",
	"payment.respond",
]);

export function may(action: Action, role: Role): boolean {
	return ALLOWED[action]?.includes(role) ?? false;
}

export function allowedWhenCompleted(action: Action): boolean {
	return WHEN_COMPLETED.has(action);
}
