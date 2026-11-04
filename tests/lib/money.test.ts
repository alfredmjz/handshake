import { describe, expect, test } from "bun:test";

import { formatAmount, minorUnitDigits, parseAmount, splitEvenly } from "@/lib/money";

describe("minorUnitDigits", () => {
	test("follows the currency", () => {
		expect(minorUnitDigits("CAD")).toBe(2);
		expect(minorUnitDigits("JPY")).toBe(0);
		expect(minorUnitDigits("KWD")).toBe(3);
	});
});

describe("parseAmount", () => {
	test("reads whole and decimal amounts as minor units", () => {
		expect(parseAmount("12", "CAD")).toBe(1200);
		expect(parseAmount("12.5", "CAD")).toBe(1250);
		expect(parseAmount("12.05", "CAD")).toBe(1205);
		expect(parseAmount(" 1,234.50 ", "CAD")).toBe(123450);
		expect(parseAmount(".75", "CAD")).toBe(75);
		expect(parseAmount("3000", "JPY")).toBe(3000);
	});

	test("rejects amounts the currency can't hold", () => {
		expect(parseAmount("12.345", "CAD")).toBeNull();
		expect(parseAmount("300.5", "JPY")).toBeNull();
	});

	test("rejects things that aren't amounts", () => {
		for (const input of ["", ".", "-5", "abc", "1.2.3", "12e3"]) expect(parseAmount(input, "CAD")).toBeNull();
	});

	test("avoids float drift", () => {
		expect(parseAmount("0.29", "CAD")).toBe(29);
		expect(parseAmount("1.15", "CAD")).toBe(115);
	});
});

describe("formatAmount", () => {
	test("formats minor units in the currency", () => {
		expect(formatAmount(123450, "CAD", "en-CA")).toBe("$1,234.50");
		expect(formatAmount(3000, "JPY", "en-CA")).toBe("JP¥3,000");
	});
});

describe("splitEvenly", () => {
	test("shares always add up to the total", () => {
		expect(splitEvenly(1000, 3)).toEqual([334, 333, 333]);
		expect(splitEvenly(1001, 3)).toEqual([334, 334, 333]);
		expect(splitEvenly(900, 3)).toEqual([300, 300, 300]);
		expect(splitEvenly(2, 3)).toEqual([1, 1, 0]);
	});

	test("refunds split the same way", () => {
		expect(splitEvenly(-1000, 3)).toEqual([-334, -333, -333]);
	});

	test("rejects fractional totals and empty splits", () => {
		expect(() => splitEvenly(10.5, 2)).toThrow(RangeError);
		expect(() => splitEvenly(1000, 0)).toThrow(RangeError);
	});
});
