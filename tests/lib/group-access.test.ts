import { describe, expect, test } from "bun:test";

import { denial, groupView, isNameTaken, makeNames, nextOwner, toLedgerMembers } from "@/lib/group-access";
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

describe("groupView", () => {
	const as = (userId: string, group: GroupRow = OPEN) => groupView({ group, members, userId })!;

	test("undefined while the group or its people load; null when the group is missing or deleted", () => {
		expect(groupView({ group: undefined, members, userId: "u-sam" })).toBeUndefined();
		expect(groupView({ group: OPEN, members: undefined, userId: "u-sam" })).toBeUndefined();
		expect(groupView({ group: null, members, userId: "u-sam" })).toBeNull();
		expect(
			groupView({ group: { ...OPEN, deletedAt: "2026-11-06T00:00:00.000Z" }, members, userId: "u-sam" })
		).toBeNull();
	});

	test("everyone, who is still in, and my active row", () => {
		const view = as("u-sam");
		expect(view.group).toBe(OPEN);
		expect(view.members.map((m) => m.id)).toEqual(["alex", "sam", "gus", "jo"]);
		expect(view.active.map((m) => m.id)).toEqual(["alex", "sam", "gus"]);
		expect(view.me?.id).toBe("sam");
		expect(as("u-jo").me).toBeNull(); // left
		expect(as("u-stranger").me).toBeNull();
	});

	test("may: the gate for my role", () => {
		expect(as("u-sam").may("entry.create")).toBe(true);
		expect(as("u-sam", COMPLETED).may("entry.create")).toBe(false);
		expect(as("u-gus").may("payment.record.others")).toBe(false);
		expect(as("u-alex").may("group.delete")).toBe(true);
	});

	test("not in it: nothing is allowed", () => {
		expect(as("u-stranger").may("entry.create")).toBe(false);
		expect(as("u-jo").may("payment.record.own")).toBe(false);
		expect(as("u-stranger").whyNot("entry.create")).toBe("You're not in this group.");
	});

	test("whyNot: the sentence the screens show", () => {
		expect(as("u-sam", COMPLETED).whyNot("entry.update")).toBe("This group is completed.");
		expect(as("u-gus").whyNot("entry.update")).toBe("Guests can't edit bills.");
		expect(as("u-gus").whyNot("payment.record.others")).toBe("Guests can't record this payment.");
		expect(as("u-gus").whyNot("conflict.resolve")).toBe("Guests can't do this.");
		expect(as("u-sam").whyNot("group.delete")).toBe("Only the group's owner can do this.");
		expect(as("u-sam").whyNot("entry.update")).toBeNull();
	});

	test("names are from my side", () => {
		expect([as("u-sam").names.of("sam"), as("u-alex").names.of("sam")]).toEqual(["You", "Sam"]);
		expect(as("u-stranger").names.of("sam")).toBe("Sam");
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

	test("signed: the name they sign with, never You or (left)", () => {
		expect([names.signed("sam"), names.signed("alex"), names.signed("jo")]).toEqual(["Sam", "Alex", "Jo"]);
		expect([names.signed("ghost"), names.signed(null), names.signed(undefined)]).toEqual([
			"Someone",
			"Someone",
			"Someone",
		]);
	});

	test("list: You starts a sentence, you anywhere else", () => {
		expect(names.list(["sam", "alex"], "start")).toBe("You and Alex");
		expect(names.list(["alex", "sam"], "start")).toBe("Alex and you");
		expect(names.list(["jo", "sam", "alex"], "start")).toBe("Jo (left), you and Alex");
		expect(names.list(["sam"], "start")).toBe("You");
		expect(names.list(["sam", "alex"], "middle")).toBe("you and Alex");
		expect(names.list(["alex", "ghost", "sam"], "middle")).toBe("Alex, Someone and you");
		expect(names.list([], "middle")).toBe("");
	});

	test("isMe goes by member id, not the name shown", () => {
		const named = makeNames([member("x", "You"), sam], "sam");
		expect([named.isMe("sam"), named.isMe("x"), named.isMe(null)]).toEqual([true, false, false]);
		expect(named.of("x")).toBe("You");
		expect(named.member("x")?.displayName).toBe("You");
		expect(named.list(["x", "sam"], "start")).toBe("You and you");
		expect(named.list(["sam", "x"], "middle")).toBe("you and You");
	});
});

describe("people and names", () => {
	test("toLedgerMembers: id, name and whether they have a login", () => {
		expect(toLedgerMembers([alex, member("nina", "Nina", { userId: null })])).toEqual([
			{ id: "alex", displayName: "Alex", hasLogin: true },
			{ id: "nina", displayName: "Nina", hasLogin: false },
		]);
	});

	test("isNameTaken compares active people's names ignoring case and outer spaces", () => {
		expect(isNameTaken(members, " sam ")).toBe(true);
		expect(isNameTaken(members, "JO")).toBe(false); // left
		expect(isNameTaken(members, "Sam", "sam")).toBe(false);
		expect(isNameTaken(members, "Lee")).toBe(false);
	});
});

describe("nextOwner: private.hand_over", () => {
	const at = (day: number) => `2026-10-0${day}T00:00:00.000Z`;
	const bo = member("bo", "Bo", { joinedAt: at(2) });
	const cy = member("cy", "Cy", { joinedAt: at(1) });
	const di = member("di", "Di", { joinedAt: at(1) });

	test("the member with a login who joined first, then by id", () => {
		expect(nextOwner([bo, di, cy, alex], "alex")?.id).toBe("cy");
	});

	test("guests, name-only people, those who left and the leaver are skipped", () => {
		const nina = member("nina", "Nina", { userId: null, joinedAt: at(1) });
		const early = (id: string, overrides: Partial<MemberRow>) => member(id, id, { joinedAt: at(1), ...overrides });
		expect(
			nextOwner(
				[
					nina,
					early("g", { role: "guest" }),
					early("k", { deletedAt: "2026-11-02T00:00:00.000Z" }),
					early("o", { role: "owner" }),
					bo,
				],
				"o"
			)?.id
		).toBe("bo");
		expect(nextOwner([cy, bo], "cy")?.id).toBe("bo");
	});

	test("a missing joinedAt sorts last, as Postgres sorts NULLs", () => {
		const unknown = member("a0", "Ann", { joinedAt: null });
		expect(nextOwner([unknown, bo], "alex")?.id).toBe("bo");
		expect(nextOwner([unknown], "alex")?.id).toBe("a0");
	});

	test("none when nobody can take over: the group goes", () => {
		expect(nextOwner([alex, gus, jo], "alex")).toBeUndefined();
	});
});
