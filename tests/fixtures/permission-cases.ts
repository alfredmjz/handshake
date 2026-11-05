// Who may do what: spec decision 8's table, transcribed by hand. private.may() and
// private.allowed_when_completed() (SQL) and may() / allowedWhenCompleted() (src/lib/permissions.ts) must
// both match it. `bun run gen:permission-cases` renders it into supabase/tests/permission_cases.test.sql,
// and tests/lib/permission-cases-sql.test.ts fails if that file is out of date.
//
// Only booleans are pinned; each side words its own refusal reasons. Chat actions (slice 8) join later.

export type PermissionRole = "owner" | "member" | "guest";

export type PermissionCase = {
	action: string;
	owner: boolean;
	member: boolean;
	guest: boolean;
	// Still allowed once the group is completed.
	whenCompleted: boolean;
};

export const PERMISSION_CASES: PermissionCase[] = [
	{ action: "group.rename", owner: true, member: false, guest: false, whenCompleted: false },
	{ action: "group.delete", owner: true, member: false, guest: false, whenCompleted: true },
	{ action: "group.complete", owner: true, member: false, guest: false, whenCompleted: false },
	{ action: "group.reopen", owner: true, member: false, guest: false, whenCompleted: true },
	{ action: "member.add", owner: true, member: true, guest: false, whenCompleted: false },
	{ action: "member.rename.self", owner: true, member: true, guest: true, whenCompleted: false },
	{ action: "member.rename.others", owner: true, member: false, guest: false, whenCompleted: false },
	{ action: "member.remove.self", owner: true, member: true, guest: true, whenCompleted: true },
	{ action: "member.remove.others", owner: true, member: false, guest: false, whenCompleted: false },
	{ action: "entry.create", owner: true, member: true, guest: true, whenCompleted: false },
	{ action: "entry.update", owner: true, member: true, guest: false, whenCompleted: false },
	{ action: "entry.delete.own", owner: true, member: true, guest: true, whenCompleted: false },
	{ action: "entry.delete.others", owner: true, member: true, guest: false, whenCompleted: false },
	{ action: "conflict.resolve", owner: true, member: true, guest: false, whenCompleted: false },
	{ action: "invite.create", owner: true, member: true, guest: false, whenCompleted: false },
	{ action: "invite.revoke.own", owner: true, member: true, guest: false, whenCompleted: false },
	{ action: "invite.revoke.others", owner: true, member: false, guest: false, whenCompleted: false },
	{ action: "payment.record.own", owner: true, member: true, guest: true, whenCompleted: false },
	{ action: "payment.record.others", owner: true, member: true, guest: false, whenCompleted: false },
	{ action: "payment.respond", owner: true, member: true, guest: true, whenCompleted: true },
	{ action: "payment.undo", owner: true, member: true, guest: true, whenCompleted: false },
];
