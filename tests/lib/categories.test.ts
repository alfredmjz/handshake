import { describe, expect, test } from "bun:test";

import { CATEGORIES, groupCategory, isCategory } from "@/lib/categories";
import type { Category, EntryRow } from "@/lib/sync/types";
import { serverBill } from "../support/memory-tables";

let n = 0;
const bill = (category: Category | null, overrides: Partial<EntryRow> = {}) =>
	serverBill({ id: `e${++n}`, groupId: "g1", createdByMemberId: "alex", category, ...overrides });

describe("categories", () => {
	test("the editor's list, in order, with labels", () => {
		expect(CATEGORIES).toEqual([
			{ id: "food", label: "Food" },
			{ id: "drinks", label: "Drinks" },
			{ id: "stay", label: "Stay" },
			{ id: "travel", label: "Travel" },
			{ id: "groceries", label: "Groceries" },
			{ id: "fun", label: "Fun" },
		]);
	});

	test("isCategory takes exactly the six ids", () => {
		for (const c of CATEGORIES) expect(isCategory(c.id)).toBe(true);
		for (const value of ["Food", "bar", "", null, undefined, 1]) expect(isCategory(value)).toBe(false);
	});
});

describe("groupCategory", () => {
	test("no bills, or none with a category: null", () => {
		expect(groupCategory([])).toBeNull();
		expect(groupCategory([bill(null), bill(null)])).toBeNull();
	});

	test("the most common category among live bills", () => {
		expect(groupCategory([bill("food"), bill("stay"), bill("food"), bill(null), bill(null), bill(null)])).toBe("food");
	});

	test("deleted bills and payments don't count", () => {
		const deleted = { deletedAt: "2026-11-05T00:00:00.000Z" };
		expect(groupCategory([bill("stay"), bill("food", deleted), bill("food", deleted)])).toBe("stay");
		const payment = bill("food", { kind: "payment", paymentStatus: "confirmed", items: null });
		expect(groupCategory([payment, payment, bill("fun")])).toBe("fun");
		expect(groupCategory([bill("food", deleted)])).toBeNull();
	});

	test("a tie goes to the most recent bill's category among the tied ones", () => {
		expect(
			groupCategory([
				bill("food", { entryDate: "2026-11-01" }),
				bill("stay", { entryDate: "2026-11-03" }),
				bill("food", { entryDate: "2026-11-02" }),
				bill("stay", { entryDate: "2026-11-01" }),
				// The most recent bill of all, but fun isn't tied for most common.
				bill("fun", { entryDate: "2026-11-09" }),
			])
		).toBe("stay");
	});

	test("the same day: the one added later is more recent", () => {
		const day = { entryDate: "2026-11-02" };
		expect(
			groupCategory([
				bill("drinks", { ...day, createdAt: "2026-11-02T20:00:00.000Z" }),
				bill("travel", { ...day, createdAt: "2026-11-02T09:00:00.000Z" }),
			])
		).toBe("drinks");
	});

	test("the order the bills come in doesn't matter", () => {
		const bills = [
			bill("food", { entryDate: "2026-11-01" }),
			bill("groceries", { entryDate: "2026-11-04" }),
			bill("food", { entryDate: "2026-11-02" }),
			bill("groceries", { entryDate: "2026-11-03" }),
		];
		expect(groupCategory(bills)).toBe("groceries");
		expect(groupCategory([...bills].reverse())).toBe("groceries");
	});
});
