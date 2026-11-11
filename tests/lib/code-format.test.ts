import { describe, expect, test } from "bun:test";

import { CODE_ALPHABET, formatCode, joinPath, normaliseCode } from "@/lib/code-format";

describe("normaliseCode", () => {
	test("takes any case, with or without the dash or spaces", () => {
		expect(normaliseCode("HX7K2P")).toBe("HX7K2P");
		expect(normaliseCode("hx7-k2p")).toBe("HX7K2P");
		expect(normaliseCode(" hx7 k2p ")).toBe("HX7K2P");
	});

	test("takes a pasted link", () => {
		expect(normaliseCode("https://handshake.app/join/HX7K2P")).toBe("HX7K2P");
		expect(normaliseCode("/join/hx7-k2p?x=1")).toBe("HX7K2P");
	});

	test("refuses what can't be a code", () => {
		expect(normaliseCode("")).toBeNull();
		expect(normaliseCode("HX7K2")).toBeNull();
		expect(normaliseCode("HX7K2PQ")).toBeNull();
		// Lookalikes are never in a code: 0, O, 1, I, L.
		expect(normaliseCode("HX0K2P")).toBeNull();
		expect(normaliseCode("HXOK2P")).toBeNull();
		expect(normaliseCode("HX1K2P")).toBeNull();
		expect(normaliseCode("HXIK2P")).toBeNull();
		expect(normaliseCode("HXLK2P")).toBeNull();
	});

	test("the alphabet is the server's: 31 characters without lookalikes", () => {
		expect(CODE_ALPHABET).toBe("ABCDEFGHJKMNPQRSTUVWXYZ23456789");
		expect(CODE_ALPHABET).toHaveLength(31);
	});
});

describe("formatCode and joinPath", () => {
	test("show the dash; the link has none", () => {
		expect(formatCode("HX7K2P")).toBe("HX7-K2P");
		expect(joinPath("HX7K2P")).toBe("/join/HX7K2P");
	});
});
