import { describe, expect, test } from "bun:test";

import { balanceFor, describeDebt, everOwed, joinedSummary, overallOf } from "@/lib/shell-view";

describe("joinedSummary", () => {
	test("names everyone up to three, alphabetically", () => {
		expect(joinedSummary([])).toBe("");
		expect(joinedSummary(["Jo"])).toBe("Jo");
		expect(joinedSummary(["Sam", "jo"])).toBe("jo and Sam");
		expect(joinedSummary(["Sam", "Ann", "Jo"])).toBe("Ann, Jo and Sam");
	});
	test("more than three: the first three and how many more", () => {
		expect(joinedSummary(["Sam", "Ann", "Jo", "Kim", "Bo"])).toBe("Ann, Bo, Jo and 2 more");
	});
});

describe("everOwed", () => {
	const bill = (shares: { memberId: string; owedTo: Record<string, number> }[], deletedAt: string | null = null) => ({
		kind: "expense" as const,
		deletedAt,
		paymentStatus: null,
		shares,
	});
	const payment = (status: string) => ({
		kind: "payment" as const,
		deletedAt: null,
		paymentStatus: status,
		shares: [
			{ memberId: "jo", owedTo: {} as Record<string, number> },
			{ memberId: "me", owedTo: { jo: 500 } as Record<string, number> },
		],
	});
	test("a new group, or bills only you shared, never had anything owed", () => {
		expect(everOwed([], "me")).toBe(false);
		expect(everOwed([bill([{ memberId: "me", owedTo: {} }])], "me")).toBe(false);
		expect(
			everOwed(
				[
					bill([
						{ memberId: "jo", owedTo: { sam: 300 } },
						{ memberId: "sam", owedTo: {} },
					]),
				],
				"me"
			)
		).toBe(false);
	});
	test("a bill split with someone counts, either way round", () => {
		expect(
			everOwed(
				[
					bill([
						{ memberId: "me", owedTo: {} },
						{ memberId: "jo", owedTo: { me: 1200 } },
					]),
				],
				"me"
			)
		).toBe(true);
		expect(
			everOwed(
				[
					bill([
						{ memberId: "me", owedTo: { jo: 1200 } },
						{ memberId: "jo", owedTo: {} },
					]),
				],
				"me"
			)
		).toBe(true);
	});
	test("deleted bills and payments that never counted don't", () => {
		expect(everOwed([bill([{ memberId: "jo", owedTo: { me: 1200 } }], "2026-11-12T00:00:00Z")], "me")).toBe(false);
		expect(everOwed([payment("pending")], "me")).toBe(false);
		expect(everOwed([payment("declined")], "me")).toBe(false);
		expect(everOwed([payment("confirmed")], "me")).toBe(true);
	});
	test("nobody to ask about", () => {
		expect(everOwed([payment("confirmed")], null)).toBe(false);
	});
});

describe("overallOf", () => {
	test("nets balances", () => {
		expect(overallOf([6000, -3000])).toEqual({ standing: "owed", cents: 3000 });
		expect(overallOf([-1000, 400])).toEqual({ standing: "owe", cents: 600 });
		expect(overallOf([500, -500])).toEqual({ standing: "settled", cents: 0 });
		expect(overallOf([])).toEqual({ standing: "settled", cents: 0 });
	});
});

describe("balanceFor", () => {
	test("finds a person or gives 0", () => {
		const people = [{ memberId: "a", balanceCents: 250 }];
		expect(balanceFor(people, "a")).toBe(250);
		expect(balanceFor(people, "b")).toBe(0);
		expect(balanceFor(people, null)).toBe(0);
	});
});

describe("describeDebt", () => {
	const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
	test("both directions", () => {
		expect(describeDebt({ groupName: "Banff", otherName: "Sam", cents: 1000, direction: "owe" }, fmt)).toBe(
			"You still owe Sam $10.00 in Banff"
		);
		expect(describeDebt({ groupName: "Banff", otherName: "Sam", cents: 1000, direction: "owed" }, fmt)).toBe(
			"Sam still owes you $10.00 in Banff"
		);
	});
});
