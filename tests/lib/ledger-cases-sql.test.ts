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
			}

			const after = { ...ledgerCase.balances };
			for (const payment of ledgerCase.payments) {
				expect(payment.amountCents).toBeGreaterThan(0);
				after[payment.from] += payment.amountCents;
				after[payment.to] -= payment.amountCents;
			}
			expect(Object.values(after).every((balance) => balance === 0)).toBe(true);
			expect(ledgerCase.payments.length).toBeLessThanOrEqual(Math.max(names.length - 1, 0));
		});
	}
});
