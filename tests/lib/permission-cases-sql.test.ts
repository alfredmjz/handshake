import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { PERMISSION_CASES_SQL_PATH, renderPermissionCasesSql } from "../../scripts/permission-cases-sql";
import { PERMISSION_CASES } from "../fixtures/permission-cases";

describe("the shared permission case table", () => {
	test("supabase/tests/permission_cases.test.sql is current (run `bun run gen:permission-cases`)", () => {
		const onDisk = readFileSync(PERMISSION_CASES_SQL_PATH, "utf8").replaceAll("\r\n", "\n");
		expect(onDisk).toBe(renderPermissionCasesSql(PERMISSION_CASES));
	});

	test("lists every action once", () => {
		const actions = PERMISSION_CASES.map((permission) => permission.action);
		expect(new Set(actions).size).toBe(actions.length);
	});

	// No role can do what the owner can't: the matrix only ever narrows from owner to member to guest.
	test("roles only narrow from owner to member to guest", () => {
		for (const permission of PERMISSION_CASES) {
			expect(permission.owner || !permission.member).toBe(true);
			expect(permission.member || !permission.guest).toBe(true);
		}
	});
});
