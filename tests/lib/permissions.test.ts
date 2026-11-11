import { describe, expect, test } from "bun:test";

import { allowedWhenCompleted, may } from "@/lib/permissions";
import type { Action, Role } from "@/lib/permissions";

import { PERMISSION_CASES } from "../fixtures/permission-cases";

const ROLES: Role[] = ["owner", "member", "guest"];

describe("permissions match the shared case table", () => {
	for (const permission of PERMISSION_CASES) {
		const action = permission.action as Action;
		for (const role of ROLES) {
			test(`${action}: ${role} ${permission[role] ? "may" : "may not"}`, () => {
				expect(may(action, role)).toBe(permission[role]);
			});
		}
		test(`${action}: ${permission.whenCompleted ? "allowed" : "refused"} in a completed group`, () => {
			expect(allowedWhenCompleted(action)).toBe(permission.whenCompleted);
		});
	}

	test("the module knows exactly the table's actions", () => {
		// Every Action key must appear in the table, and unknown strings are refused for everyone.
		const everyAction: Record<Action, true> = {
			"group.rename": true,
			"group.delete": true,
			"group.complete": true,
			"group.reopen": true,
			"member.add": true,
			"member.rename.self": true,
			"member.rename.others": true,
			"member.remove.self": true,
			"member.remove.others": true,
			"entry.create": true,
			"entry.update": true,
			"entry.delete.own": true,
			"entry.delete.others": true,
			"conflict.resolve": true,
			"invite.create": true,
			"invite.revoke.own": true,
			"invite.revoke.others": true,
			"payment.record.own": true,
			"payment.record.others": true,
			"payment.respond": true,
			"payment.undo": true,
			"nudge.send": true,
		};
		expect(Object.keys(everyAction).sort()).toEqual(PERMISSION_CASES.map((permission) => permission.action).sort());
		for (const role of ROLES) expect(may("nope" as Action, role)).toBe(false);
		expect(allowedWhenCompleted("nope" as Action)).toBe(false);
	});
});
