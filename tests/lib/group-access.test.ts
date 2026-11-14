import { describe, expect, test } from "bun:test";

import { denial, groupAccess, makeNames } from "@/lib/group-access";
import type { GroupRow, MemberRow } from "@/lib/sync/types";
import { serverGroup, serverMember } from "../support/memory-tables";

const member = (id: string, displayName: string, overrides: Partial<MemberRow> = {}) =>
	serverMember({ id, groupId: "g1", userId: `u-${id}`, displayName, role: "member", ...overrides });

const OPEN: GroupRow = serverGroup({ id: "g1" });
const COMPLETED: GroupRow = { ...OPEN, completedAt: "2026-11-05T00:00:00.000Z" };

const alex = member("alex", "Alex", { role: "owner" });
const sam = member("sam", "Sam");
const gus = member("gus", "Gus", { role: "guest" });
const jo = member("jo", "Jo", { deletedAt: "2026-11-02T00:00:00.000Z" });
const members = [alex, sam, gus, jo];

describe("denial: the gate", () => {
	test("not a member, then completed, then the role", () => {
		expect(denial(OPEN, null, "entry.create")).toBe("not-member");
		expect(denial(COMPLETED, "guest", "entry.update")).toBe("completed");
		expect(denial(OPEN, "member", "group.rename")).toBe("owner-only");
		expect(denial(OPEN, "guest", "entry.update")).toBe("guests");
		expect(denial(OPEN, "guest", "entry.create")).toBeNull();
	});

	test("a completed group still allows what it allows", () => {
		expect(denial(COMPLETED, "member", "payment.respond")).toBeNull();
		expect(denial(COMPLETED, "owner", "group.reopen")).toBeNull();
		expect(denial(COMPLETED, "owner", "entry.create")).toBe("completed");
	});
});

describe("groupAccess", () => {
	test("may: the gate, and nothing before the group has loaded", () => {
		expect(groupAccess({ group: OPEN, members, me: sam }).may("entry.create")).toBe(true);
		expect(groupAccess({ group: COMPLETED, members, me: sam }).may("entry.create")).toBe(false);
		expect(groupAccess({ group: OPEN, members, me: gus }).may("payment.record.others")).toBe(false);
		expect(groupAccess({ group: undefined, members, me: sam }).may("entry.create")).toBe(false);
		expect(groupAccess({ group: OPEN, members, me: null }).may("entry.create")).toBe(false);
	});

	test("whyNot: the sentence the screens show", () => {
		const as = (me: MemberRow | null, group: GroupRow = OPEN) => groupAccess({ group, members, me });
		expect(as(null).whyNot("entry.create")).toBe("You're not in this group.");
		expect(as(sam, COMPLETED).whyNot("entry.update")).toBe("This group is completed.");
		expect(as(gus).whyNot("entry.update")).toBe("Guests can't edit bills.");
		expect(as(gus).whyNot("payment.record.others")).toBe("Guests can't record this payment.");
		expect(as(gus).whyNot("conflict.resolve")).toBe("Guests can't do this.");
		expect(as(sam).whyNot("group.delete")).toBe("Only the group's owner can do this.");
		expect(as(sam).whyNot("entry.update")).toBeNull();
	});
});

describe("makeNames", () => {
	const names = makeNames(members, "sam");

	test("You, a name, (left), Someone", () => {
		expect([names.of("sam"), names.of("alex"), names.of("jo"), names.of("ghost"), names.of(null)]).toEqual([
			"You",
			"Alex",
			"Jo (left)",
			"Someone",
			"Someone",
		]);
	});

	test("inSentence lower-cases only you", () => {
		expect([names.inSentence("sam"), names.inSentence("alex"), names.inSentence("jo")]).toEqual([
			"you",
			"Alex",
			"Jo (left)",
		]);
	});

	test("isMe goes by member id, not the name shown", () => {
		const named = makeNames([member("x", "You"), sam], "sam");
		expect([named.isMe("sam"), named.isMe("x"), named.isMe(null)]).toEqual([true, false, false]);
		expect(named.of("x")).toBe("You");
		expect(named.member("x")?.displayName).toBe("You");
	});
});
