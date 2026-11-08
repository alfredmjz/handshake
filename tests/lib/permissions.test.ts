import { describe, expect, test } from "bun:test";

import { allowedWhenCompleted, may, type Action } from "@/lib/permissions";
import { PERMISSION_CASES } from "../fixtures/permission-cases";

describe("the permission case table", () => {
	for (const permission of PERMISSION_CASES) {
		const action = permission.action as Action;
		test(action, () => {
			expect(may(action, "owner")).toBe(permission.owner);
			expect(may(action, "member")).toBe(permission.member);
			expect(may(action, "guest")).toBe(permission.guest);
			expect(allowedWhenCompleted(action)).toBe(permission.whenCompleted);
		});
	}

	test("an action the table doesn't know is never allowed", () => {
		expect(may("group.transfer" as Action, "owner")).toBe(false);
		expect(allowedWhenCompleted("group.transfer" as Action)).toBe(false);
	});
});
