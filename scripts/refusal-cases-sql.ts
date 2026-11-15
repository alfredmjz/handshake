// Renders the refusal case table (tests/fixtures/refusal-cases.ts) into a pgTAP file that pushes each case's
// mutation through push_changes() as its actor, from the world in supabase/tests/refusal-world.psql, and checks
// the outcome. It only formats: the expected codes are the table's.
// `bun run gen:refusal-cases` writes the file; tests/lib/refusal-cases-sql.test.ts checks it is current.

import { GROUP, REFUSAL_CASES, SAM_INVITE, USERS, worldState } from "../tests/fixtures/refusal-cases";
import type { GroupSetup, RefusalCase } from "../tests/fixtures/refusal-cases";
import { renderCaseSqlFile, sqlString, sqlTestPath, writeCaseSqlFile } from "./case-sql";

export const REFUSAL_CASES_SQL_PATH = sqlTestPath("refusal_cases.test.sql");

// What the owner pushes first to get the group into the case's state.
const SETUP: Record<GroupSetup, string> = {
	open: "NULL",
	completed: sqlString(JSON.stringify({ type: "group.complete", groupId: GROUP })),
	deleted: sqlString(JSON.stringify({ type: "group.delete", groupId: GROUP })),
};

// The psql world must be the table's WORLD: the people, entries, conflict, invite and nudge the cases name.
function renderWorldChecks(): string[] {
	const world = worldState("alex", "open")!;
	const check = (actual: string, expected: string, description: string) =>
		`SELECT is((${actual}), ${sqlString(expected)}, ${sqlString(`the world: ${description}`)});`;
	const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
	const idList = (table: string) =>
		`SELECT string_agg(id::TEXT, ' ' ORDER BY id::TEXT) FROM public.${table} WHERE group_id = ${sqlString(GROUP)}`;
	return [
		check(idList("group_members"), ids(world.members).join(" "), "no one else is in the group"),
		...world.members.map((m) =>
			check(
				`SELECT role || ', ' || COALESCE(user_id::TEXT, 'no login') || CASE WHEN deleted_at IS NULL THEN '' ELSE ', left' END FROM public.group_members WHERE id = ${sqlString(m.id)}`,
				`${m.role}, ${m.userId ?? "no login"}${m.deletedAt ? ", left" : ""}`,
				m.displayName
			)
		),
		check(idList("ledger_entries"), ids(world.entries).join(" "), "no other entries"),
		...world.entries.map((e) =>
			check(
				`SELECT kind || COALESCE(', ' || payment_status, '') FROM public.ledger_entries WHERE id = ${sqlString(e.id)} AND deleted_at IS NULL`,
				`${e.kind}${e.paymentStatus ? `, ${e.paymentStatus}` : ""}`,
				e.description
			)
		),
		...world.conflicts.map((conflict) =>
			check(
				`SELECT entry_id::TEXT FROM public.entry_conflicts WHERE id = ${sqlString(conflict.id)} AND resolved_at IS NULL`,
				conflict.entryId,
				"the open conflict"
			)
		),
		check(
			`SELECT created_by::TEXT FROM public.group_invites WHERE id = ${sqlString(SAM_INVITE)} AND revoked_at IS NULL`,
			USERS.sam,
			"Sam's invite"
		),
		...(world.nudges ?? []).map((nudge) =>
			check(
				`SELECT from_member_id || ' to ' || to_member_id FROM public.nudges WHERE id = ${sqlString(nudge.id)}`,
				`${nudge.fromMemberId} to ${nudge.toMemberId}`,
				"Sam's nudge"
			)
		),
	];
}

function renderCase(refusalCase: RefusalCase): string {
	const outcome = `pg_temp.outcome(${SETUP[refusalCase.group]}, ${sqlString(USERS[refusalCase.actor])}, ${sqlString(JSON.stringify(refusalCase.mutation))})`;
	const expected = refusalCase.expect === "accepted" ? "applied" : refusalCase.expect;
	return [
		`-- ${refusalCase.mutation.type}`,
		`SELECT is(${outcome}, ${sqlString(expected)}, ${sqlString(refusalCase.name)});`,
	].join("\n");
}

export function renderRefusalCasesSql(cases: RefusalCase[]): string {
	const worldChecks = renderWorldChecks();
	return renderCaseSqlFile({
		script: "gen:refusal-cases",
		table: "tests/fixtures/refusal-cases.ts",
		driftTest: "tests/lib/refusal-cases-sql.test.ts",
		about:
			"It first checks the world in refusal-world.psql is the table's WORLD, then each case pushes one mutation " +
			"as its actor from that world and checks it is applied or refused with the table's code; planChange is " +
			"held to the same table (tests/lib/refusal-cases.test.ts).",
		tests: worldChecks.length + cases.length,
		includes: ["prelude.psql", "refusal-world.psql"],
		body: [...worldChecks, "", cases.map(renderCase).join("\n\n")].join("\n"),
	});
}

if (import.meta.main) {
	writeCaseSqlFile(REFUSAL_CASES_SQL_PATH, renderRefusalCasesSql(REFUSAL_CASES), `${REFUSAL_CASES.length} cases`);
}
