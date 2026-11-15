import { describe, expect, test } from "bun:test";

import { formatCountdown, secondsUntilResend } from "@/lib/resend-cooldown";

const SENT = 1_000_000;

describe("secondsUntilResend", () => {
	test("nothing sent yet: no wait", () => {
		expect(secondsUntilResend(null, SENT)).toBe(0);
	});

	test("counts down a minute from the send, rounding up", () => {
		expect(secondsUntilResend(SENT, SENT)).toBe(60);
		expect(secondsUntilResend(SENT, SENT + 1)).toBe(60);
		expect(secondsUntilResend(SENT, SENT + 999)).toBe(60);
		expect(secondsUntilResend(SENT, SENT + 1_000)).toBe(59);
		expect(secondsUntilResend(SENT, SENT + 59_001)).toBe(1);
	});

	test("free again once the minute is up", () => {
		expect(secondsUntilResend(SENT, SENT + 60_000)).toBe(0);
		expect(secondsUntilResend(SENT, SENT + 600_000)).toBe(0);
	});
});

describe("formatCountdown", () => {
	test("minutes and two-digit seconds", () => {
		expect(formatCountdown(60)).toBe("1:00");
		expect(formatCountdown(59)).toBe("0:59");
		expect(formatCountdown(5)).toBe("0:05");
		expect(formatCountdown(0)).toBe("0:00");
	});
});
