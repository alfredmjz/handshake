// Renders the shared case table (tests/fixtures/ledger-cases.ts) into a pgTAP file that runs every case
// through private.compute_shares. It only formats: the expected cents are the table's, never computed.
// `bun run gen:ledger-cases` writes the file; tests/lib/ledger-cases-sql.test.ts checks it is current.

import { LEDGER_CASES } from "../tests/fixtures/ledger-cases";
import type { LedgerCase } from "../tests/fixtures/ledger-cases";
import { renderCaseSqlFile, sqlString, sqlTestPath, writeCaseSqlFile } from "./case-sql";

export const LEDGER_CASES_SQL_PATH = sqlTestPath("ledger_cases.test.sql");

// The n-th person in a case's `members` gets the same id in every case.
export function memberUuid(index: number): string {
	return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function renderCase(ledgerCase: LedgerCase): string {
	const idOf = (name: string) => {
		const index = ledgerCase.members.indexOf(name);
		if (index < 0) throw new Error(`${ledgerCase.name}: ${name} is not in members`);
		return memberUuid(index);
	};

	const shareNames = Object.keys(ledgerCase.owed);
	for (const other of [ledgerCase.paid, ledgerCase.parts]) {
		const names = Object.keys(other);
		if (names.length !== shareNames.length || names.some((name) => !(name in ledgerCase.owed))) {
			throw new Error(`${ledgerCase.name}: paid, owed and parts must name the same people`);
		}
	}
	const owedTo = (name: string) =>
		JSON.stringify(
			Object.fromEntries(Object.entries(ledgerCase.parts[name]).map(([payer, cents]) => [idOf(payer), cents]))
		);

	const items = JSON.stringify(
		ledgerCase.items.map((item) => ({
			amountCents: item.amountCents,
			paidBy: idOf(item.paidBy),
			splitAmong: item.splitAmong.map(idOf),
		}))
	);
	const rows = shareNames.map((name, index) => {
		const comma = index < shareNames.length - 1 ? "," : "";
		return `        (${sqlString(idOf(name))}::UUID, ${ledgerCase.paid[name]}::BIGINT, ${ledgerCase.owed[name]}::BIGINT, ${sqlString(owedTo(name))}::JSONB)${comma} -- ${name}`;
	});

	return [
		`-- ${ledgerCase.name}`,
		"SELECT results_eq(",
		`    $$ SELECT member_id, paid_cents, owed_cents, owed_to FROM private.compute_shares(${sqlString(items)}::JSONB) $$,`,
		"    $$ VALUES",
		...rows,
		"    $$,",
		`    ${sqlString(ledgerCase.name)}`,
		");",
	].join("\n");
}

export function renderLedgerCasesSql(cases: LedgerCase[]): string {
	return renderCaseSqlFile({
		script: "gen:ledger-cases",
		table: "tests/fixtures/ledger-cases.ts",
		driftTest: "tests/lib/ledger-cases-sql.test.ts",
		about:
			"Every pinned bill runs through private.compute_shares, the SQL twin of computeShares in src/lib/ledger.ts, " +
			"and must return the hand-worked shares (with owed_to, per payer) in bill order.",
		tests: cases.length,
		body: cases.map(renderCase).join("\n\n"),
	});
}

if (import.meta.main) {
	writeCaseSqlFile(LEDGER_CASES_SQL_PATH, renderLedgerCasesSql(LEDGER_CASES), `${LEDGER_CASES.length} cases`);
}
