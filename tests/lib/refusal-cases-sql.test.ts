import { describe, expect, test } from "bun:test";

import { REFUSAL_CASES_SQL_PATH, renderRefusalCasesSql } from "../../scripts/refusal-cases-sql";
import { readSqlFile } from "../../scripts/case-sql";
import { REFUSAL_CASES } from "../fixtures/refusal-cases";

describe("the shared refusal case table", () => {
	test("supabase/tests/refusal_cases.test.sql is current (run `bun run gen:refusal-cases`)", () => {
		expect(readSqlFile(REFUSAL_CASES_SQL_PATH)).toBe(renderRefusalCasesSql(REFUSAL_CASES));
	});

	test("names each case once", () => {
		const names = REFUSAL_CASES.map((refusalCase) => refusalCase.name);
		expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
	});
});
