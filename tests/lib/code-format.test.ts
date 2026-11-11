import { describe, expect, test } from "bun:test";

import { CODE_ALPHABET, codeKind, formatCode, joinPath, normaliseCode, readCode } from "@/lib/code-format";

describe("normaliseCode", () => {
	test("takes any case, with or without the dash or spaces", () => {
		expect(normaliseCode("HX7K2P")).toBe("HX7K2P");
		expect(normaliseCode("hx7-k2p")).toBe("HX7K2P");
		expect(normaliseCode(" hx7 k2p ")).toBe("HX7K2P");
		expect(normaliseCode("7kqm-2dxh")).toBe("7KQM2DXH");
	});

	test("takes a pasted link", () => {
		expect(normaliseCode("https://handshake.app/join/HX7K2P")).toBe("HX7K2P");
		expect(normaliseCode("/join/hx7-k2p?x=1")).toBe("HX7K2P");
		expect(normaliseCode("https://handshake.app/join/7kqm-2dxh#top")).toBe("7KQM2DXH");
	});

	test("refuses what can't be a code", () => {
		expect(normaliseCode("")).toBeNull();
		expect(normaliseCode("HX7K2")).toBeNull();
		expect(normaliseCode("HX7K2PQ")).toBeNull();
		expect(normaliseCode("7KQM2DXHA")).toBeNull();
		// Lookalikes are never in a code: 0, O, 1, I, L.
		expect(normaliseCode("HX0K2P")).toBeNull();
		expect(normaliseCode("HXOK2P")).toBeNull();
		expect(normaliseCode("HX1K2P")).toBeNull();
		expect(normaliseCode("HXIK2P")).toBeNull();
		expect(normaliseCode("HXLK2P")).toBeNull();
		expect(normaliseCode("7KQM2DX0")).toBeNull();
	});

	test("the alphabet is the server's: 31 characters without lookalikes", () => {
		expect(CODE_ALPHABET).toBe("ABCDEFGHJKMNPQRSTUVWXYZ23456789");
		expect(CODE_ALPHABET).toHaveLength(31);
	});
});

describe("codeKind and readCode", () => {
	test("6 characters is a group code, 8 a personal code", () => {
		expect(codeKind("HX7K2P")).toBe("group");
		expect(codeKind("7KQM2DXH")).toBe("personal");
	});

	test("readCode gives the kind with the stored code, from anything the box takes", () => {
		expect(readCode("hx7-k2p")).toEqual({ kind: "group", code: "HX7K2P" });
		expect(readCode("7kqm-2dxh")).toEqual({ kind: "personal", code: "7KQM2DXH" });
		expect(readCode("https://handshake.app/join/7KQM2DXH")).toEqual({ kind: "personal", code: "7KQM2DXH" });
		expect(readCode("7KQM2DX")).toBeNull();
	});
});

describe("formatCode and joinPath", () => {
	test("show the dash in the middle; the link has none", () => {
		expect(formatCode("HX7K2P")).toBe("HX7-K2P");
		expect(formatCode("7KQM2DXH")).toBe("7KQM-2DXH");
		expect(joinPath("HX7K2P")).toBe("/join/HX7K2P");
		expect(joinPath("7KQM2DXH")).toBe("/join/7KQM2DXH");
	});
});
