import { describe, expect, test } from "bun:test";

import { charLength, storedNote } from "@/lib/stored-text";

describe("stored text", () => {
	test("storedNote trims spaces only, and blank is no note", () => {
		expect(storedNote("  Ski week  ")).toBe("Ski week");
		expect(storedNote("\tTabbed\n")).toBe("\tTabbed\n");
		expect([storedNote("   "), storedNote(""), storedNote(null), storedNote(undefined)]).toEqual([
			null,
			null,
			null,
			null,
		]);
	});

	test("charLength counts code points, as Postgres does", () => {
		expect([charLength("abc"), charLength("🤝"), charLength("")]).toEqual([3, 1, 0]);
	});
});
