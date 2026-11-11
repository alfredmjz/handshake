import { describe, expect, test } from "bun:test";

import { toLedgerMembers } from "@/lib/changes";
import { currentDebt, lastNudge, nextNudgeAt, nudgedRecently, receivedNudges, unseenCount } from "@/lib/nudge-view";
import type { MemberRow, NudgeRow } from "@/lib/sync/types";
import { serverBill, serverGroup, serverMember } from "../support/memory-tables";

const NOW = "2026-11-08T10:00:00.000Z";
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 60 * 60 * 1000).toISOString();

const nudge = (id: string, fields: Partial<NudgeRow> = {}): NudgeRow => ({
	id,
	groupId: "g1",
	fromMemberId: "alex",
	toMemberId: "sam",
	amountCents: 1000,
	createdAt: hoursAgo(1),
	rowVersion: 2,
	...fields,
});

// Me (user-s) as Sam in g1 and as Sam2 in g2; I left g3; g4 is deleted.
const MEMBERS: MemberRow[] = [
	serverMember({ id: "alex", groupId: "g1", userId: "user-a", displayName: "Alex" }),
	serverMember({ id: "sam", groupId: "g1", userId: "user-s", displayName: "Sam", role: "member" }),
	serverMember({ id: "gus", groupId: "g1", userId: "user-g", displayName: "Gus", role: "guest" }),
	serverMember({ id: "kim", groupId: "g2", userId: "user-k", displayName: "Kim" }),
	serverMember({ id: "sam2", groupId: "g2", userId: "user-s", displayName: "Sam", role: "member" }),
	serverMember({ id: "lee", groupId: "g3", userId: "user-l", displayName: "Lee" }),
	serverMember({ id: "sam3", groupId: "g3", userId: "user-s", role: "member", deletedAt: hoursAgo(5) }),
	serverMember({ id: "ann", groupId: "g4", userId: "user-n", displayName: "Ann" }),
	serverMember({ id: "sam4", groupId: "g4", userId: "user-s", role: "member" }),
];
const GROUPS = [
	serverGroup({ id: "g1", name: "Lisbon" }),
	serverGroup({ id: "g2", name: "Banff" }),
	serverGroup({ id: "g3", name: "Old" }),
	serverGroup({ id: "g4", name: "Gone", deletedAt: hoursAgo(5) }),
];

describe("currentDebt", () => {
	const bill = serverBill({
		id: "e1",
		groupId: "g1",
		createdByMemberId: "alex",
		amountCents: 2000,
		shares: [
			{ memberId: "alex", paidCents: 2000, owedCents: 1000, owedTo: { alex: 1000 } },
			{ memberId: "sam", paidCents: 0, owedCents: 1000, owedTo: { alex: 1000 } },
		],
	});
	const members = toLedgerMembers(MEMBERS.filter((m) => m.groupId === "g1"));

	test("what one owes the other now, or 0", () => {
		expect(currentDebt([bill], members, "sam", "alex")).toBe(1000);
		expect(currentDebt([bill], members, "alex", "sam")).toBe(0);
		expect(currentDebt([{ ...bill, deletedAt: NOW }], members, "sam", "alex")).toBe(0);
	});
});

describe("lastNudge and the 24-hour rule", () => {
	const nudges = [
		nudge("old", { createdAt: hoursAgo(30) }),
		nudge("new", { createdAt: hoursAgo(2) }),
		nudge("other", { fromMemberId: "gus", createdAt: hoursAgo(1) }),
	];

	test("the newest nudge from one person to another", () => {
		expect(lastNudge(nudges, "alex", "sam")?.id).toBe("new");
		expect(lastNudge(nudges, "sam", "alex")).toBeNull();
	});

	test("nudged within 24 hours blocks another until 24 hours after it", () => {
		expect(nudgedRecently(lastNudge(nudges, "alex", "sam"), NOW)).toBe(true);
		expect(nextNudgeAt(lastNudge(nudges, "alex", "sam"), NOW)).toBe(
			new Date(Date.parse(hoursAgo(2)) + 86_400_000).toISOString()
		);
		expect(nudgedRecently(nudge("x", { createdAt: hoursAgo(24) }), NOW)).toBe(false);
		expect(nudgedRecently(nudge("x", { createdAt: hoursAgo(23.9) }), NOW)).toBe(true);
		expect(nudgedRecently(null, NOW)).toBe(false);
		expect(nextNudgeAt(null, NOW)).toBeNull();
	});
});

describe("receivedNudges", () => {
	const nudges = [
		nudge("to-me-g1", { createdAt: hoursAgo(3) }),
		nudge("to-me-g2", { groupId: "g2", fromMemberId: "kim", toMemberId: "sam2", createdAt: hoursAgo(1) }),
		nudge("to-gus", { toMemberId: "gus" }),
		nudge("left-group", { groupId: "g3", fromMemberId: "lee", toMemberId: "sam3" }),
		nudge("deleted-group", { groupId: "g4", fromMemberId: "ann", toMemberId: "sam4" }),
	];

	test("only nudges to me, in groups I'm still in, newest first, with names", () => {
		const received = receivedNudges(nudges, GROUPS, MEMBERS, "user-s", new Set(["to-me-g1"]));
		expect(received.map((n) => [n.id, n.groupName, n.fromName, n.unseen])).toEqual([
			["to-me-g2", "Banff", "Kim", true],
			["to-me-g1", "Lisbon", "Alex", false],
		]);
		expect(unseenCount(received)).toBe(1);
	});

	test("nothing seen yet: all unseen", () => {
		expect(unseenCount(receivedNudges(nudges, GROUPS, MEMBERS, "user-s", new Set()))).toBe(2);
	});
});
