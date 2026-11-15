// Renders the permission case table (tests/fixtures/permission-cases.ts) into a pgTAP file that checks
// private.may() and private.allowed_when_completed() against it. It only formats.
// `bun run gen:permission-cases` writes the file; tests/lib/permission-cases-sql.test.ts checks it is current.

import { PERMISSION_CASES } from "../tests/fixtures/permission-cases";
import type { PermissionCase, PermissionRole } from "../tests/fixtures/permission-cases";
import { renderCaseSqlFile, sqlString, sqlTestPath, writeCaseSqlFile } from "./case-sql";

export const PERMISSION_CASES_SQL_PATH = sqlTestPath("permission_cases.test.sql");

const ROLES: PermissionRole[] = ["owner", "member", "guest"];

function renderCase(permission: PermissionCase): string {
	const action = sqlString(permission.action);
	const roleLines = ROLES.map((role) => {
		const allowed = permission[role];
		const description = sqlString(`${permission.action}: ${role} ${allowed ? "may" : "may not"}`);
		return `SELECT is(private.may(${action}, ${sqlString(role)}), ${allowed}, ${description});`;
	});
	const completed = sqlString(
		`${permission.action}: ${permission.whenCompleted ? "allowed" : "refused"} in a completed group`
	);
	return [
		`-- ${permission.action}`,
		...roleLines,
		`SELECT is(private.allowed_when_completed(${action}), ${permission.whenCompleted}, ${completed});`,
	].join("\n");
}

export function renderPermissionCasesSql(cases: PermissionCase[]): string {
	return renderCaseSqlFile({
		script: "gen:permission-cases",
		table: "tests/fixtures/permission-cases.ts",
		driftTest: "tests/lib/permission-cases-sql.test.ts",
		about:
			'Every action x role, and every "allowed in a completed group" mark, against private.may() and ' +
			"private.allowed_when_completed(), the SQL twins of src/lib/permissions.ts.",
		tests: cases.length * (ROLES.length + 1),
		body: cases.map(renderCase).join("\n\n"),
	});
}

if (import.meta.main) {
	writeCaseSqlFile(
		PERMISSION_CASES_SQL_PATH,
		renderPermissionCasesSql(PERMISSION_CASES),
		`${PERMISSION_CASES.length} actions`
	);
}
