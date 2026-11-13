import { describe, expect, test } from "bun:test";

import { emailedCodeIn } from "@/lib/emailed-code";

describe("emailedCodeIn", () => {
	test("takes the code alone, with stray spaces or a line break", () => {
		expect(emailedCodeIn("482913")).toBe("482913");
		expect(emailedCodeIn("  482913\n")).toBe("482913");
	});

	test("takes the code split in two", () => {
		expect(emailedCodeIn("482 913")).toBe("482913");
		expect(emailedCodeIn("482-913")).toBe("482913");
	});

	test("takes the code from a short line around it", () => {
		expect(emailedCodeIn("Your Handshake verification code is 482913.")).toBe("482913");
		expect(emailedCodeIn("482913 482913")).toBe("482913");
	});

	test("refuses anything that isn't one 6-digit code", () => {
		expect(emailedCodeIn("")).toBeNull();
		expect(emailedCodeIn("48291")).toBeNull();
		expect(emailedCodeIn("4829137")).toBeNull();
		expect(emailedCodeIn("604-555-1234")).toBeNull();
		expect(emailedCodeIn("2026-11-13")).toBeNull();
		expect(emailedCodeIn("HX7K2P")).toBeNull();
		expect(emailedCodeIn("482913 or 105227")).toBeNull();
		expect(emailedCodeIn(`A long paragraph that happens to mention 482913 ${"somewhere ".repeat(10)}`)).toBeNull();
	});
});
