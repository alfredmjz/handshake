import { describe, expect, test } from "bun:test";

import { formatAmount, parseAmount } from "@/lib/money";

describe("parseAmount", () => {
	test("reads whole and decimal amounts as cents", () => {
		expect(parseAmount("12")).toBe(1200);
		expect(parseAmount("12.5")).toBe(1250);
		expect(parseAmount("12.05")).toBe(1205);
		expect(parseAmount("1,234.50")).toBe(123450);
		expect(parseAmount(" 1,234.50 ")).toBe(123450);
		expect(parseAmount(".75")).toBe(75);
		expect(parseAmount("0.01")).toBe(1);
		expect(parseAmount("0")).toBe(0);
	});

	test("rejects more than 2 decimals", () => {
		expect(parseAmount("1.234")).toBeNull();
		expect(parseAmount("12.345")).toBeNull();
	});

	test("rejects things that aren't amounts", () => {
		for (const input of ["", " ", ".", "-5", "-0.50", "abc", "1.2.3", "12e3", "$5", "1,23", "12,34.50", "1 000"]) {
			expect(parseAmount(input)).toBeNull();
		}
	});

	test("rejects amounts too large to hold exactly", () => {
		expect(parseAmount("99999999999999999999")).toBeNull();
	});
});

describe("formatAmount", () => {
	test("shows dollars with grouping and two decimals", () => {
		expect(formatAmount(123450)).toBe("$1,234.50");
		expect(formatAmount(0)).toBe("$0.00");
		expect(formatAmount(5)).toBe("$0.05");
		expect(formatAmount(100000000)).toBe("$1,000,000.00");
	});

	test("shows negatives with a true minus sign", () => {
		expect(formatAmount(-333)).toBe("−$3.33");
		expect(formatAmount(-123450)).toBe("−$1,234.50");
	});
});
