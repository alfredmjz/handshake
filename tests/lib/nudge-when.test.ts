import { describe, expect, test } from "bun:test";

import { openNudge, sentWhen } from "@/lib/nudge-view";
import type { EntryRow, NudgeRow } from "@/lib/sync/types";
import { serverBill } from "../support/memory-tables";

// Local times, so the test holds in any time zone.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();
const NOW = new Date(2026, 10, 10, 9);

describe("sentWhen", () => {
	test("earlier the same local day is today", () => {
		expect(sentWhen(at(2026, 11, 10, 0), NOW)).toBe("today");
	});

	test("the local day before is yesterday, even late at night", () => {
		expect(sentWhen(at(2026, 11, 9, 23), NOW)).toBe("yesterday");
		expect(sentWhen(at(2026, 11, 9, 0), NOW)).toBe("yesterday");
	});

	test("older is the short date", () => {
		expect(sentWhen(at(2026, 11, 3), NOW)).toBe("3 Nov");
	});

	test("another year adds the year", () => {
		expect(sentWhen(at(2025, 12, 31), new Date(2026, 0, 5))).toBe("31 Dec 2025");
	});

	test("yesterday across a month boundary", () => {
		expect(sentWhen(at(2026, 10, 31, 20), new Date(2026, 10, 1, 8))).toBe("yesterday");
	});
});

const nudge = (createdAt: string): NudgeRow => ({
	id: "n1",
	groupId: "g1",
	fromMemberId: "alex",
	toMemberId: "sam",
	amountCents: 2000,
	createdAt,
	rowVersion: 2,
});

const payment = (from: string, to: string, fields: Partial<EntryRow> = {}): EntryRow =>
	serverBill({
		id: `p-${from}-${to}`,
		groupId: "g1",
		createdByMemberId: from,
		kind: "payment",
		items: null,
		paymentStatus: "confirmed",
		confirmedAt: "2026-11-05T12:00:00.000Z",
		shares: [
			{ memberId: from, paidCents: 2000, owedCents: 0, owedTo: {} },
			{ memberId: to, paidCents: 0, owedCents: 2000, owedTo: {} },
		],
		...fields,
	});

describe("openNudge", () => {
	test("a nudge with no payment since is open", () => {
		expect(openNudge(nudge("2026-11-04T12:00:00.000Z"), [], "alex", "sam")?.id).toBe("n1");
	});

	test("a counted payment from the nudged person after it answers it", () => {
		expect(openNudge(nudge("2026-11-04T12:00:00.000Z"), [payment("sam", "alex")], "alex", "sam")).toBeNull();
	});

	test("a payment before the nudge, the other way, waiting, or deleted leaves it open", () => {
		const n = nudge("2026-11-04T12:00:00.000Z");
		const early = payment("sam", "alex", { confirmedAt: "2026-11-03T12:00:00.000Z" });
		const otherWay = payment("alex", "sam");
		const waiting = payment("sam", "alex", { paymentStatus: "pending", confirmedAt: null });
		const deleted = payment("sam", "alex", { deletedAt: "2026-11-06T12:00:00.000Z" });
		expect(openNudge(n, [early, otherWay, waiting, deleted], "alex", "sam")?.id).toBe("n1");
	});

	test("no nudge stays null", () => {
		expect(openNudge(null, [], "alex", "sam")).toBeNull();
	});
});
