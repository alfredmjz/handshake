import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { LEDGER_CASES_SQL_PATH, renderLedgerCasesSql } from "../../scripts/ledger-cases-sql";
import { LEDGER_CASES } from "../fixtures/ledger-cases";

describe("the shared ledger case table", () => {
	test("supabase/tests/ledger_cases.test.sql is current (run `bun run gen:ledger-cases`)", () => {
		const onDisk = readFileSync(LEDGER_CASES_SQL_PATH, "utf8").replaceAll("\r\n", "\n");
		expect(onDisk).toBe(renderLedgerCasesSql(LEDGER_CASES));
	});

	// Catches slips in the hand-worked numbers; it checks the table against itself, not against code.
	for (const ledgerCase of LEDGER_CASES) {
		test(`${ledgerCase.name}: the numbers add up`, () => {
			const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
			const total = sum(ledgerCase.items.map((item) => item.amountCents));
			const names = Object.keys(ledgerCase.owed);

			expect(sum(Object.values(ledgerCase.paid))).toBe(total);
			expect(sum(Object.values(ledgerCase.owed))).toBe(total);
			expect(Object.keys(ledgerCase.balances).sort()).toEqual([...names].sort());
			for (const name of names) {
				expect(ledgerCase.members).toContain(name);
				expect(ledgerCase.balances[name]).toBe(ledgerCase.paid[name] - ledgerCase.owed[name]);
				expect(sum(Object.values(ledgerCase.parts[name]))).toBe(ledgerCase.owed[name]);
			}

			// Each payer is owed, in parts, exactly what they paid.
			for (const name of names) {
				const owedToThem = sum(names.map((debtor) => ledgerCase.parts[debtor][name] ?? 0));
				expect(owedToThem).toBe(ledgerCase.paid[name]);
			}

			// The debts are the parts netted per pair, nothing more.
			const netted: { from: string; to: string; amountCents: number }[] = [];
			for (const [i, a] of names.entries()) {
				for (const b of names.slice(i + 1)) {
					const net = (ledgerCase.parts[a][b] ?? 0) - (ledgerCase.parts[b][a] ?? 0);
					if (net > 0) netted.push({ from: a, to: b, amountCents: net });
					if (net < 0) netted.push({ from: b, to: a, amountCents: -net });
				}
			}
			const byPair = (x: { from: string; to: string }, y: { from: string; to: string }) =>
				x.from.localeCompare(y.from) || x.to.localeCompare(y.to);
			expect([...ledgerCase.debts].sort(byPair)).toEqual(netted.sort(byPair));

			for (const name of names) {
				const owedToThem = sum(ledgerCase.debts.filter((debt) => debt.to === name).map((debt) => debt.amountCents));
				const theyOwe = sum(ledgerCase.debts.filter((debt) => debt.from === name).map((debt) => debt.amountCents));
				expect(owedToThem - theyOwe).toBe(ledgerCase.balances[name]);
			}
		});
	}
});
