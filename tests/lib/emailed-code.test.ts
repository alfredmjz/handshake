import { describe, expect, test } from "bun:test";

import { CODE_LENGTH, emailedCodeIn } from "@/lib/emailed-code";

describe("emailedCodeIn", () => {
	test("matches the length the auth server sends", () => {
		expect(CODE_LENGTH).toBe(8);
	});

	test("takes the code alone, with stray spaces or a line break", () => {
		expect(emailedCodeIn("22549805")).toBe("22549805");
		expect(emailedCodeIn("  22549805\n")).toBe("22549805");
	});

	test("takes the code split in two", () => {
		expect(emailedCodeIn("2254 9805")).toBe("22549805");
		expect(emailedCodeIn("2254-9805")).toBe("22549805");
	});

	test("takes the code from a short line around it", () => {
		expect(emailedCodeIn("Your Handshake verification code is 22549805.")).toBe("22549805");
		expect(emailedCodeIn("22549805 22549805")).toBe("22549805");
	});

	test("refuses anything that isn't one 8-digit code", () => {
		expect(emailedCodeIn("")).toBeNull();
		expect(emailedCodeIn("482913")).toBeNull();
		expect(emailedCodeIn("2254980")).toBeNull();
		expect(emailedCodeIn("225498051")).toBeNull();
		expect(emailedCodeIn("604-555-1234")).toBeNull();
		expect(emailedCodeIn("2026-11-13")).toBeNull();
		expect(emailedCodeIn("HX7K2P9Q")).toBeNull();
		expect(emailedCodeIn("22549805 or 10522731")).toBeNull();
		expect(emailedCodeIn(`A long paragraph that happens to mention 22549805 ${"somewhere ".repeat(10)}`)).toBeNull();
	});
});
