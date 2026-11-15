// Renders the pull key table (tests/fixtures/pull-keys.ts) into a pgTAP file that builds a group with a row in
// every synced table (supabase/tests/pull-scenario.psql), pulls it as the owner, and checks the keys at each
// level of the JSON. It only formats.
// `bun run gen:pull-keys` writes the file; tests/lib/sync/pull-keys.test.ts checks it is current.

import { PULL_KEYS } from "../tests/fixtures/pull-keys";
import type { PullLevel } from "../tests/fixtures/pull-keys";
import { readSqlFile, renderCaseSqlFile, sqlTestPath, writeCaseSqlFile } from "./case-sql";

export const PULL_KEYS_SQL_PATH = sqlTestPath("pull_keys.test.sql");
const SCENARIO_PATH = sqlTestPath("pull-scenario.psql");

const CHANGES = "pulled, jsonb_array_elements(body->'changes') c";

function rowsOf(level: PullLevel): string {
	if (level === "pull") return "SELECT body AS r FROM pulled";
	if (level === "changes") return `SELECT c AS r FROM ${CHANGES}`;
	if (level === "shares") {
		return `SELECT x AS r FROM ${CHANGES}, jsonb_array_elements(c->'entries') e, jsonb_array_elements(e->'shares') x`;
	}
	return `SELECT x AS r FROM ${CHANGES}, jsonb_array_elements(c->'${level}') x`;
}

// Every key seen in any row at that level; a level with no rows gives an empty array and fails.
function renderLevel(level: PullLevel, keys: string[]): string {
	return [
		"SELECT is(",
		`    ARRAY(SELECT k FROM (SELECT DISTINCT jsonb_object_keys(r) AS k FROM (${rowsOf(level)}) rows) keys ORDER BY k COLLATE "C"),`,
		`    ARRAY[${keys.map((key) => `'${key}'`).join(", ")}]::TEXT[],`,
		`    '${level}: exactly the keys in tests/fixtures/pull-keys.ts'`,
		");",
	].join("\n");
}

// The row builders run as the caller inside pull_changes(): signed-in users may call them, signed-out ones not.
// Every level below a group's changes has one.
const ROW_BUILDERS =
	"SELECT p.oid, p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'pull\\_%\\_row'";

function rowBuilderGrants(levels: PullLevel[]): string[] {
	const builders = levels.filter((level) => level !== "pull" && level !== "changes").length;
	return [
		`SELECT is((SELECT count(*) FROM (${ROW_BUILDERS}) b), ${builders}::BIGINT, 'there are ${builders} row builders');`,
		`SELECT is(ARRAY(SELECT proname::TEXT FROM (${ROW_BUILDERS}) b WHERE NOT has_function_privilege('authenticated', b.oid, 'EXECUTE') ORDER BY 1), '{}'::TEXT[], 'signed-in users may call every row builder');`,
		`SELECT is(ARRAY(SELECT proname::TEXT FROM (${ROW_BUILDERS}) b WHERE has_function_privilege('anon', b.oid, 'EXECUTE') ORDER BY 1), '{}'::TEXT[], 'signed-out callers may call none');`,
	];
}

export function renderPullKeysSql(pullKeys: Record<PullLevel, string[]>, scenario: string): string {
	const levels = Object.entries(pullKeys) as Array<[PullLevel, string[]]>;
	const grants = rowBuilderGrants(levels.map(([level]) => level));
	const scenarioTests = scenario.match(/^SELECT isn?t?\(/gm)?.length ?? 0;
	return renderCaseSqlFile({
		script: "gen:pull-keys",
		table: "tests/fixtures/pull-keys.ts",
		driftTest: "tests/lib/sync/pull-keys.test.ts",
		about:
			"pull_changes() must send exactly those keys at each level of its JSON (migration 017's row builders), " +
			"and only signed-in users may call the row builders.",
		tests: scenarioTests + levels.length + grants.length,
		includes: ["prelude.psql", "pull-scenario.psql"],
		body: [
			"CREATE TEMP TABLE pulled AS SELECT pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') AS body;",
			"",
			levels.map(([level, keys]) => renderLevel(level, keys)).join("\n"),
			"",
			...grants,
		].join("\n"),
	});
}

export function readPullScenario(): string {
	return readSqlFile(SCENARIO_PATH);
}

if (import.meta.main) {
	writeCaseSqlFile(
		PULL_KEYS_SQL_PATH,
		renderPullKeysSql(PULL_KEYS, readPullScenario()),
		`${Object.keys(PULL_KEYS).length} levels`
	);
}
