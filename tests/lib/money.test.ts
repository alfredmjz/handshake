import { describe, expect, test } from "bun:test";

import { formatAmount, parseAmount } from "@/lib/money";

describe("parseAmount", () => {
	test("reads whole and decimal dollars as cents", () => {
		expect(parseAmount("12")).toBe(1200);
		expect(parseAmount("12.5")).toBe(1250);
		expect(parseAmount("12.05")).toBe(1205);
		expect(parseAmount("1,234.50")).toBe(123450);
		expect(parseAmount(" 1,234.50 ")).toBe(123450);
		expect(parseAmount(".75")).toBe(75);
		expect(parseAmount("12.")).toBe(1200);
	});

	test("rejects more than two decimals", () => {
		expect(parseAmount("1.234")).toBeNull();
		expect(parseAmount("12.345")).toBeNull();
	});

	test("rejects things that aren't amounts", () => {
		for (const input of ["", ".", "-5", "abc", "1.2.3", "12e3", "$5"]) expect(parseAmount(input)).toBeNull();
	});

	test("avoids float drift", () => {
		expect(parseAmount("0.29")).toBe(29);
		expect(parseAmount("1.15")).toBe(115);
	});

	test("rejects amounts too big to count exactly", () => {
		expect(parseAmount("99999999999999999")).toBeNull();
	});
});

describe("formatAmount", () => {
	test("formats cents as dollars with thousands separators", () => {
		expect(formatAmount(123450)).toBe("$1,234.50");
		expect(formatAmount(0)).toBe("$0.00");
		expect(formatAmount(5)).toBe("$0.05");
		expect(formatAmount(100000000000)).toBe("$1,000,000,000.00");
	});

	test("negative amounts use a real minus sign", () => {
		expect(formatAmount(-333)).toBe("−$3.33");
	});
});
