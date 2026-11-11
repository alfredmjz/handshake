import { describe, expect, test } from "bun:test";

import { balanceFor, describeDebt, joinedSummary, overallOf } from "@/lib/shell-view";

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
