import { describe, expect, test } from "bun:test";

import {
	billVersionOf,
	conflictFields,
	defaultChoices,
	dayLabel,
	effectOn,
	groupByDay,
	isVisibleTo,
	joinNames,
	mergeVersions,
	payerIds,
	resolutionOf,
	roundingCents,
	sentenceList,
	shortDate,
	type BillVersion,
} from "@/lib/group-view";
import { computeShares } from "@/lib/ledger";
import type { Item, Share } from "@/lib/sync/types";

const item = (id: string, amountCents: number, paidBy: string, splitAmong: string[]): Item => ({
	id,
	amountCents,
	paidBy,
	splitAmong,
});
const share = (memberId: string, paidCents: number, owedCents: number): Share => ({
	memberId,
	paidCents,
	owedCents,
	owedTo: {},
});

describe("days", () => {
	test("groupByDay keeps the order and starts a run per new day", () => {
		const days = groupByDay([
			{ id: "a", entryDate: "2026-11-04" },
			{ id: "b", entryDate: "2026-11-04" },
			{ id: "c", entryDate: "2026-11-03" },
		]);
		expect(days.map((d) => [d.date, d.entries.map((e) => e.id)])).toEqual([
			["2026-11-04", ["a", "b"]],
			["2026-11-03", ["c"]],
		]);
		expect(groupByDay([])).toEqual([]);
	});

	test("dayLabel: weekday, day and month; the year only when it isn't this year", () => {
		expect(dayLabel("2026-11-04", "2026-11-08")).toBe("Wed 4 Nov");
		expect(dayLabel("2025-01-03", "2026-11-08")).toBe("Fri 3 Jan 2025");
	});

	test("shortDate takes a calendar date or a timestamp", () => {
		expect(shortDate("2026-11-22", "2026-11-08")).toBe("22 Nov");
		expect(shortDate("2026-11-03T12:00:00.000Z", "2026-11-08")).toBe("3 Nov");
		expect(shortDate("2027-02-01", "2026-11-08")).toBe("1 Feb 2027");
	});

	test("joinNames", () => {
		expect(joinNames([])).toBe("");
		expect(joinNames(["Alex"])).toBe("Alex");
		expect(joinNames(["Alex", "Sam"])).toBe("Alex and Sam");
		expect(joinNames(["Alex", "Jo", "Sam"])).toBe("Alex, Jo and Sam");
	});

	test("sentenceList: You starts a sentence, and is lower case after", () => {
		expect(sentenceList(["You", "Sam"])).toBe("You and Sam");
		expect(sentenceList(["alex.f", "You"])).toBe("alex.f and you");
		expect(sentenceList(["Jo", "You", "Sam"])).toBe("Jo, you and Sam");
		expect(sentenceList(["You"])).toBe("You");
	});
});

describe("who sees what", () => {
	const payment = (paymentStatus: "pending" | "confirmed" | "declined" | "undone") => ({
		kind: "payment" as const,
		paymentStatus,
		shares: [share("sam", 3000, 0), share("alex", 0, 3000)],
	});

	test("bills and payments that count show to everyone", () => {
		expect(isVisibleTo({ kind: "expense", paymentStatus: null, shares: [] }, "jo")).toBe(true);
		expect(isVisibleTo(payment("confirmed"), "jo")).toBe(true);
		expect(isVisibleTo(payment("confirmed"), null)).toBe(true);
	});

	test("pending, declined and undone payments show only to their two people", () => {
		for (const status of ["pending", "declined", "undone"] as const) {
			expect(isVisibleTo(payment(status), "sam")).toBe(true);
			expect(isVisibleTo(payment(status), "alex")).toBe(true);
			expect(isVisibleTo(payment(status), "jo")).toBe(false);
			expect(isVisibleTo(payment(status), null)).toBe(false);
		}
	});

	test("effectOn: Dinner $90.00 paid by Alex, split by Alex, Sam and Jo", () => {
		const dinner = {
			kind: "expense" as const,
			shares: [share("alex", 9000, 3000), share("sam", 0, 3000), share("jo", 0, 3000)],
		};
		expect(effectOn(dinner, "alex")).toEqual({ kind: "lent", cents: 6000 });
		expect(effectOn(dinner, "sam")).toEqual({ kind: "owe", cents: 3000 });
		expect(effectOn(dinner, "kim")).toEqual({ kind: "none", cents: 0 });
		expect(effectOn(dinner, null)).toEqual({ kind: "none", cents: 0 });
		expect(effectOn({ kind: "expense", shares: [share("alex", 500, 500)] }, "alex")).toEqual({
			kind: "even",
			cents: 500,
		});
		expect(effectOn({ kind: "payment", shares: [share("alex", 500, 0)] }, "alex").kind).toBe("none");
	});

	test("payerIds lists those who paid, in share order", () => {
		expect(payerIds({ shares: [share("a", 0, 10), share("b", 500, 0), share("c", 300, 10)] })).toEqual(["b", "c"]);
	});
});

describe("roundingCents", () => {
	const notes = (items: Item[]) => Object.fromEntries(roundingCents(items, computeShares(items)));

	test("$10.00 by Alex, Jo and Sam, Sam paid: Sam covers 1¢ ($3.34 against $3.33)", () => {
		expect(notes([item("i", 1000, "sam", ["alex", "jo", "sam"])])).toEqual({ sam: 1 });
	});

	test("$20.00 by Alex, Jo and Sam, Sam paid: 1¢ comes off Sam ($6.66 against $6.67)", () => {
		expect(notes([item("i", 2000, "sam", ["alex", "jo", "sam"])])).toEqual({ sam: -1 });
	});

	test("an even split has nothing to note", () => {
		expect(notes([item("i", 5000, "p1", ["p1", "p2", "p3", "p4", "p5"])])).toEqual({});
	});

	test("several payers: P1 covers 1¢ on its own item ($7.34 against $3.33 + $4.00)", () => {
		expect(
			notes([item("a", 1000, "p1", ["p1", "p2", "p3"]), item("b", 2000, "p2", ["p1", "p2", "p3", "p4", "p5"])])
		).toEqual({ p1: 1 });
	});

	test("a payer outside the split: the extra cent comes off the first person ($6.66 against $6.67)", () => {
		expect(notes([item("i", 2000, "a", ["b", "c", "d"])])).toEqual({ b: -1 });
	});

	test("rounding once per payer: two $10.00 items by 3, same payer: B and C $6.67, the payer $6.66", () => {
		expect(notes([item("x", 1000, "a", ["a", "b", "c"]), item("y", 1000, "a", ["a", "b", "c"])])).toEqual({ a: -1 });
	});
});

describe("conflicts", () => {
	const current: BillVersion = {
		description: "Dinner",
		entryDate: "2026-11-04",
		notes: null,
		category: "food",
		items: [item("i1", 9000, "alex", ["alex", "jo", "sam"])],
	};
	const proposed: BillVersion = {
		description: "Dinner at Ichiran",
		entryDate: "2026-11-04",
		notes: "",
		category: "food",
		items: [item("i1", 9000, "alex", ["sam", "jo"]), item("i2", 700, "jo", ["jo"])],
	};

	test("conflictFields marks what differs; notes null and blank are the same; items by position", () => {
		expect(conflictFields(current, proposed)).toEqual([
			{ key: "description", changed: true },
			{ key: "entryDate", changed: false },
			{ key: "notes", changed: false },
			{ key: "category", changed: false },
			{ key: "item:0", changed: true },
			{ key: "item:1", changed: true },
		]);
	});

	test("the order of people in an item doesn't make it different", () => {
		const a = { ...current, items: [item("i1", 9000, "alex", ["alex", "jo"])] };
		const b = { ...current, items: [item("other-id", 9000, "alex", ["jo", "alex"])] };
		expect(conflictFields(a, b).find((f) => f.key === "item:0")?.changed).toBe(false);
	});

	test("mergeVersions takes each chosen field; unchosen fields stay current; a missing item is dropped", () => {
		expect(mergeVersions(current, proposed, {})).toEqual({
			description: "Dinner",
			entryDate: "2026-11-04",
			notes: null,
			category: "food",
			items: [item("i1", 9000, "alex", ["alex", "jo", "sam"])],
		});
		expect(mergeVersions(current, proposed, { description: "proposed", "item:1": "proposed" })).toEqual({
			description: "Dinner at Ichiran",
			entryDate: "2026-11-04",
			notes: null,
			category: "food",
			items: [item("i1", 9000, "alex", ["alex", "jo", "sam"]), item("i2", 700, "jo", ["jo"])],
		});
		expect(mergeVersions(proposed, current, { "item:1": "proposed" }).items).toEqual([
			item("i1", 9000, "alex", ["sam", "jo"]),
		]);
	});

	test("resolutionOf: one side for every changed field, or merged", () => {
		const fields = conflictFields(current, proposed);
		expect(resolutionOf(fields, {})).toBe("kept_current");
		expect(resolutionOf(fields, { description: "proposed", "item:0": "proposed", "item:1": "proposed" })).toBe(
			"took_proposed"
		);
		expect(resolutionOf(fields, { description: "proposed" })).toBe("merged");
		// Unchanged fields don't count either way.
		expect(resolutionOf(fields, { entryDate: "proposed" })).toBe("kept_current");
		expect(resolutionOf(conflictFields(current, current), {})).toBe("kept_current");
	});

	test("billVersionOf reads a stored entry; a payment's null items become none", () => {
		expect(
			billVersionOf({ description: "Payment", entryDate: "2026-11-04", notes: null, category: null, items: null })
		).toEqual({ description: "Payment", entryDate: "2026-11-04", notes: null, category: null, items: [] });
	});

	test("defaultChoices takes each field from whoever changed it since the base", () => {
		const base: BillVersion = { ...current, items: [item("i1", 9000, "alex", ["alex", "jo", "sam"])] };
		// Jo renamed it (current); Alex changed the amount (proposed).
		const jo: BillVersion = { ...base, description: "Dinner at Ichiran" };
		const alex: BillVersion = { ...base, items: [item("i1", 9600, "alex", ["alex", "jo", "sam"])] };
		expect(defaultChoices(base, jo, alex)).toEqual({ "item:0": "proposed" });
		// Both changed the description: the current version stays.
		expect(defaultChoices(base, jo, { ...alex, description: "Ramen" })).toEqual({ "item:0": "proposed" });
		expect(defaultChoices(null, jo, alex)).toEqual({});
	});
});
