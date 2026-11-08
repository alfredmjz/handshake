import { describe, expect, test } from "bun:test";

import { planChange, type ExpenseDraft, type GroupState, type Intent, type PlanContext } from "@/lib/changes";
import { computeShares, type Share } from "@/lib/ledger";
import type { Role } from "@/lib/permissions";
import type { ConflictRow, EntryRow, InviteRow, MemberRow } from "@/lib/sync/types";
import { PERMISSION_CASES } from "../fixtures/permission-cases";
import { serverEntry, serverGroup, serverMember } from "../support/memory-tables";

const NOW = "2026-11-04T18:00:00.000Z";
const G = "g";

function ctx(overrides: Partial<PlanContext> = {}): PlanContext {
	let n = 0;
	return {
		newId: () => `id${++n}`,
		randomToken: () => "T".repeat(43),
		now: NOW,
		today: "2026-11-04",
		isAnonymous: false,
		...overrides,
	};
}

// Owner Olive, member Max and guest Gus have logins; Nia and Ned are name-only; Lee left.
const MEMBERS: MemberRow[] = [
	serverMember({ id: "o", groupId: G, userId: "u-o", displayName: "Olive", role: "owner" }),
	serverMember({ id: "mem", groupId: G, userId: "u-m", displayName: "Max", role: "member" }),
	serverMember({ id: "g", groupId: G, userId: "u-g", displayName: "Gus", role: "guest" }),
	serverMember({ id: "n1", groupId: G, userId: null, displayName: "Nia", role: "member", joinedAt: null }),
	serverMember({ id: "n2", groupId: G, userId: null, displayName: "Ned", role: "member", joinedAt: null }),
	serverMember({
		id: "left",
		groupId: G,
		userId: "u-l",
		displayName: "Lee",
		role: "member",
		deletedAt: "2026-11-02T00:00:00Z",
	}),
];
const MEMBER_FOR: Record<Role, string> = { owner: "o", member: "mem", guest: "g" };
// Someone with a login who isn't `me`, to be the other side of a handshake.
const OTHER_FOR: Record<Role, string> = { owner: "mem", member: "o", guest: "o" };

const items = (paidBy: string, splitAmong: string[], amountCents = 1000) => [
	{ id: "i1", amountCents, paidBy, splitAmong },
];
const draft = (overrides: Partial<ExpenseDraft> = {}): ExpenseDraft => ({
	description: "Dinner",
	entryDate: "2026-11-04",
	notes: null,
	items: items("o", ["o", "mem", "g"]),
	...overrides,
});
const bill = (id: string, createdBy: string, overrides: Partial<EntryRow> = {}) => {
	const split = [...new Set([createdBy, "n1"])];
	return serverEntry({
		id,
		groupId: G,
		createdByMemberId: createdBy,
		updatedByMemberId: createdBy,
		items: items(createdBy, split),
		shares: computeShares(items(createdBy, split)),
		rowVersion: 7,
		...overrides,
	});
};
const paymentShares = (from: string, to: string, amountCents = 500): Share[] =>
	computeShares([{ id: "p", amountCents, paidBy: from, splitAmong: [to] }]);
const pendingPayment = (id: string, from: string, to: string, startedBy: string) =>
	serverEntry({
		id,
		groupId: G,
		kind: "payment",
		description: "Payment",
		amountCents: 500,
		items: null,
		paymentStatus: "pending",
		payerConfirmedAt: startedBy === from ? NOW : null,
		receiverConfirmedAt: startedBy === to ? NOW : null,
		createdByMemberId: startedBy,
		updatedByMemberId: startedBy,
		shares: paymentShares(from, to),
	});
const conflict = (overrides: Partial<ConflictRow> = {}): ConflictRow => ({
	id: "c",
	groupId: G,
	entryId: "b-o",
	baseVersion: 5,
	base: null,
	proposed: null,
	proposedByMemberId: "mem",
	createdAt: NOW,
	resolvedAt: null,
	resolvedByMemberId: null,
	resolution: null,
	rowVersion: 8,
	...overrides,
});
const invite = (id: string, createdBy: string | null, overrides: Partial<InviteRow> = {}): InviteRow => ({
	id,
	groupId: G,
	claimMemberId: null,
	createdBy,
	createdAt: NOW,
	expiresAt: "2026-11-18T18:00:00.000Z",
	revokedAt: null,
	rowVersion: 3,
	...overrides,
});

function state(role: Role, overrides: Partial<GroupState> = {}): GroupState {
	const memberId = MEMBER_FOR[role];
	const me = MEMBERS.find((m) => m.id === memberId)!;
	return {
		group: serverGroup({ id: G }),
		members: MEMBERS,
		entries: [bill("b-o", "o"), bill("b-mem", "mem"), bill("b-g", "g"), bill("b-n1", "n1")],
		conflicts: [conflict()],
		invites: [invite("inv-o", "u-o"), invite("inv-mem", "u-m"), invite("inv-gone", null)],
		me: { memberId, userId: me.userId!, role },
		...overrides,
	};
}

// One intent per row of the permission case table, built for whoever is asking.
const INTENT_FOR: Record<string, (role: Role) => { intent: Intent; state?: Partial<GroupState> }> = {
	"group.rename": () => ({ intent: { groupId: G, type: "renameGroup", name: "Banff" } }),
	"group.delete": () => ({ intent: { groupId: G, type: "deleteGroup" } }),
	"group.complete": () => ({ intent: { groupId: G, type: "completeGroup" } }),
	"group.reopen": () => ({
		intent: { groupId: G, type: "reopenGroup" },
		state: { group: serverGroup({ id: G, completedAt: NOW, completedByMemberId: "o" }) },
	}),
	"member.add": () => ({ intent: { groupId: G, type: "addPerson", displayName: "Kim" } }),
	"member.rename.self": (role) => ({
		intent: { groupId: G, type: "renamePerson", memberId: MEMBER_FOR[role], displayName: "Me" },
	}),
	"member.rename.others": () => ({ intent: { groupId: G, type: "renamePerson", memberId: "n1", displayName: "Nina" } }),
	"member.remove.self": (role) => ({ intent: { groupId: G, type: "removePerson", memberId: MEMBER_FOR[role] } }),
	"member.remove.others": () => ({ intent: { groupId: G, type: "removePerson", memberId: "n1" } }),
	"entry.create": () => ({ intent: { groupId: G, type: "addExpense", draft: draft() } }),
	"entry.update": () => ({ intent: { groupId: G, type: "editExpense", entryId: "b-o", draft: draft() } }),
	"entry.delete.own": (role) => ({ intent: { groupId: G, type: "deleteEntry", entryId: `b-${MEMBER_FOR[role]}` } }),
	"entry.delete.others": () => ({ intent: { groupId: G, type: "deleteEntry", entryId: "b-n1" } }),
	"conflict.resolve": () => ({
		intent: { groupId: G, type: "resolveConflict", conflictId: "c", resolution: "kept_current", final: draft() },
	}),
	"invite.create": () => ({ intent: { groupId: G, type: "createInvite", claimMemberId: "n1" } }),
	"invite.revoke.own": (role) => ({
		intent: { groupId: G, type: "revokeInvite", inviteId: "mine" },
		state: { invites: [invite("mine", `u-${role === "owner" ? "o" : role === "member" ? "m" : "g"}`)] },
	}),
	"invite.revoke.others": () => ({ intent: { groupId: G, type: "revokeInvite", inviteId: "inv-gone" } }),
	"payment.record.own": (role) => ({
		intent: {
			groupId: G,
			type: "recordPayment",
			from: MEMBER_FOR[role],
			to: "n1",
			amountCents: 500,
			entryDate: "2026-11-04",
			notes: null,
		},
	}),
	"payment.record.others": () => ({
		intent: {
			groupId: G,
			type: "recordPayment",
			from: "n1",
			to: "n2",
			amountCents: 500,
			entryDate: "2026-11-04",
			notes: null,
		},
	}),
	"payment.respond": (role) => ({
		intent: { groupId: G, type: "confirmPayment", entryId: "p" },
		state: { entries: [pendingPayment("p", OTHER_FOR[role], MEMBER_FOR[role], OTHER_FOR[role])] },
	}),
	"payment.undo": (role) => ({
		intent: { groupId: G, type: "undoPayment", entryId: "p" },
		state: { entries: [pendingPayment("p", MEMBER_FOR[role], OTHER_FOR[role], MEMBER_FOR[role])] },
	}),
};

describe("planChange: the role matrix, one intent per action", () => {
	test("every action in the case table has an intent", () => {
		expect(Object.keys(INTENT_FOR).sort()).toEqual(PERMISSION_CASES.map((c) => c.action).sort());
	});

	for (const permission of PERMISSION_CASES) {
		for (const role of ["owner", "member", "guest"] as const) {
			const allowed = permission[role];
			test(`${permission.action} by the ${role}: ${allowed ? "allowed" : "HS403"}`, () => {
				const { intent, state: extra } = INTENT_FOR[permission.action](role);
				const plan = planChange(state(role, extra), intent, ctx());
				if (allowed) expect(plan).toMatchObject({ ok: true });
				else expect(plan).toMatchObject({ ok: false, code: "HS403" });
			});
		}

		const completed = permission.whenCompleted;
		test(`${permission.action} in a completed group: ${completed ? "allowed" : "HS403"}`, () => {
			const role = permission.owner ? "owner" : "member";
			const { intent, state: extra } = INTENT_FOR[permission.action](role);
			const done = serverGroup({ id: G, completedAt: NOW, completedByMemberId: "o" });
			const plan = planChange(state(role, { ...extra, group: done }), intent, ctx());
			if (completed) expect(plan).toMatchObject({ ok: true });
			else expect(plan).toEqual({ ok: false, code: "HS403", reason: "This group is completed" });
		});
	}

	test("someone who isn't in the group, or a group this device doesn't have, gets HS403", () => {
		const intent: Intent = { groupId: G, type: "renameGroup", name: "x" };
		expect(planChange(null, intent, ctx())).toMatchObject({ ok: false, code: "HS403" });
		expect(planChange(state("owner", { me: null }), intent, ctx())).toMatchObject({ ok: false, code: "HS403" });
	});

	test("nothing works in a deleted group, deleting included", () => {
		const gone = state("owner", { group: serverGroup({ id: G, deletedAt: NOW }) });
		expect(planChange(gone, { groupId: G, type: "deleteGroup" }, ctx())).toEqual({
			ok: false,
			code: "HS403",
			reason: "This group was deleted",
		});
	});
});

describe("planChange: each intent's mutations", () => {
	test("createGroup", () => {
		expect(planChange(null, { type: "createGroup", name: " Banff ", displayName: " Alex " }, ctx())).toEqual({
			ok: true,
			createdId: "id1",
			mutations: [
				{
					id: "id3",
					at: NOW,
					type: "group.create",
					groupId: "id1",
					memberId: "id2",
					name: "Banff",
					displayName: "Alex",
				},
			],
		});
	});

	test("createGroup: guests can't, and names must fit", () => {
		expect(
			planChange(null, { type: "createGroup", name: "Banff", displayName: "A" }, ctx({ isAnonymous: true }))
		).toMatchObject({
			ok: false,
			code: "HS403",
		});
		expect(planChange(null, { type: "createGroup", name: "  ", displayName: "A" }, ctx())).toMatchObject({
			code: "HS422",
		});
		expect(planChange(null, { type: "createGroup", name: "x".repeat(81), displayName: "A" }, ctx())).toMatchObject({
			code: "HS422",
		});
		expect(planChange(null, { type: "createGroup", name: "Banff", displayName: "" }, ctx())).toMatchObject({
			code: "HS422",
		});
	});

	test("renameGroup, deleteGroup, completeGroup", () => {
		const s = state("owner");
		expect(planChange(s, { groupId: G, type: "renameGroup", name: " Banff " }, ctx())).toEqual({
			ok: true,
			createdId: null,
			mutations: [{ id: "id1", at: NOW, type: "group.rename", groupId: G, name: "Banff" }],
		});
		expect(planChange(s, { groupId: G, type: "deleteGroup" }, ctx())).toMatchObject({
			mutations: [{ type: "group.delete", groupId: G }],
		});
		expect(planChange(s, { groupId: G, type: "completeGroup" }, ctx())).toMatchObject({
			mutations: [{ type: "group.complete", groupId: G }],
		});
	});

	test("reopening an open group plans nothing", () => {
		expect(planChange(state("owner"), { groupId: G, type: "reopenGroup" }, ctx())).toEqual({
			ok: true,
			mutations: [],
			createdId: null,
		});
	});

	test("addPerson, renamePerson, removePerson", () => {
		const s = state("owner");
		expect(planChange(s, { groupId: G, type: "addPerson", displayName: " Kim " }, ctx())).toEqual({
			ok: true,
			createdId: "id1",
			mutations: [{ id: "id2", at: NOW, type: "member.add", groupId: G, memberId: "id1", displayName: "Kim" }],
		});
		expect(
			planChange(s, { groupId: G, type: "renamePerson", memberId: "n1", displayName: "Nina" }, ctx())
		).toMatchObject({
			mutations: [{ type: "member.rename", groupId: G, memberId: "n1", displayName: "Nina" }],
		});
		expect(planChange(s, { groupId: G, type: "removePerson", memberId: "n1" }, ctx())).toMatchObject({
			mutations: [{ type: "member.remove", groupId: G, memberId: "n1" }],
		});
		// Someone who already left: nothing to do.
		expect(planChange(s, { groupId: G, type: "removePerson", memberId: "left" }, ctx())).toMatchObject({
			ok: true,
			mutations: [],
		});
	});

	test("people not in the group, and names that don't fit, are HS422", () => {
		const s = state("owner");
		expect(
			planChange(s, { groupId: G, type: "renamePerson", memberId: "nobody", displayName: "X" }, ctx())
		).toMatchObject({ code: "HS422" });
		expect(planChange(s, { groupId: G, type: "removePerson", memberId: "nobody" }, ctx())).toMatchObject({
			code: "HS422",
		});
		expect(planChange(s, { groupId: G, type: "addPerson", displayName: "x".repeat(61) }, ctx())).toMatchObject({
			code: "HS422",
		});
	});

	test("addExpense works out the amount and shares from the items", () => {
		const plan = planChange(
			state("guest"),
			{ groupId: G, type: "addExpense", draft: draft({ description: " Dinner " }) },
			ctx()
		);
		const its = items("o", ["o", "mem", "g"]);
		expect(plan).toEqual({
			ok: true,
			createdId: "id1",
			mutations: [
				{
					id: "id2",
					at: NOW,
					type: "entry.create",
					groupId: G,
					entryId: "id1",
					description: "Dinner",
					amountCents: 1000,
					entryDate: "2026-11-04",
					notes: null,
					items: its,
					shares: computeShares(its),
				},
			],
		});
	});

	test("a bad bill is HS422 with the first problem", () => {
		const s = state("owner");
		for (const bad of [
			draft({ description: "" }),
			draft({ items: [] }),
			draft({ items: items("o", []) }),
			draft({ items: items("stranger", ["o"]) }),
			draft({ entryDate: "2026-02-30" }),
			draft({ items: items("o", ["o"], 0) }),
		]) {
			expect(planChange(s, { groupId: G, type: "addExpense", draft: bad }, ctx())).toMatchObject({
				ok: false,
				code: "HS422",
			});
		}
	});

	test("editExpense starts from the entry's version", () => {
		expect(
			planChange(state("member"), { groupId: G, type: "editExpense", entryId: "b-o", draft: draft() }, ctx())
		).toMatchObject({
			ok: true,
			mutations: [{ type: "entry.update", entryId: "b-o", baseVersion: 7, amountCents: 1000 }],
		});
	});

	test("payments can't be edited or deleted", () => {
		const s = state("owner", { entries: [pendingPayment("p", "o", "mem", "o")] });
		expect(planChange(s, { groupId: G, type: "editExpense", entryId: "p", draft: draft() }, ctx())).toMatchObject({
			code: "HS422",
		});
		expect(planChange(s, { groupId: G, type: "deleteEntry", entryId: "p" }, ctx())).toMatchObject({ code: "HS422" });
	});

	test("deleteEntry, and deleting twice plans nothing", () => {
		const s = state("owner");
		expect(planChange(s, { groupId: G, type: "deleteEntry", entryId: "b-mem" }, ctx())).toMatchObject({
			mutations: [{ type: "entry.delete", entryId: "b-mem", baseVersion: 7 }],
		});
		const deleted = state("owner", { entries: [bill("b-o", "o", { deletedAt: NOW })] });
		expect(planChange(deleted, { groupId: G, type: "deleteEntry", entryId: "b-o" }, ctx())).toMatchObject({
			ok: true,
			mutations: [],
		});
		expect(planChange(s, { groupId: G, type: "deleteEntry", entryId: "nope" }, ctx())).toMatchObject({ code: "HS422" });
	});

	test("resolveConflict: the final bill or a delete; a resolved one is HS409 naming the resolver", () => {
		const s = state("member");
		expect(
			planChange(
				s,
				{ groupId: G, type: "resolveConflict", conflictId: "c", resolution: "took_proposed", final: "deleted" },
				ctx()
			)
		).toMatchObject({
			mutations: [
				{
					type: "conflict.resolve",
					conflictId: "c",
					entryId: "b-o",
					resolution: "took_proposed",
					entry: { deleted: true },
				},
			],
		});
		expect(
			planChange(
				s,
				{ groupId: G, type: "resolveConflict", conflictId: "c", resolution: "merged", final: draft() },
				ctx()
			)
		).toMatchObject({
			mutations: [{ entry: { description: "Dinner", amountCents: 1000, shares: computeShares(draft().items) } }],
		});

		const resolved = state("member", {
			conflicts: [conflict({ resolvedAt: NOW, resolvedByMemberId: "o", resolution: "kept_current" })],
		});
		expect(
			planChange(
				resolved,
				{ groupId: G, type: "resolveConflict", conflictId: "c", resolution: "merged", final: "deleted" },
				ctx()
			)
		).toEqual({ ok: false, code: "HS409", reason: "Olive already resolved this" });
	});

	test("createInvite: the token, 14 days, and only for someone who hasn't joined", () => {
		expect(planChange(state("member"), { groupId: G, type: "createInvite", claimMemberId: null }, ctx())).toEqual({
			ok: true,
			createdId: "id1",
			mutations: [
				{
					id: "id2",
					at: NOW,
					type: "invite.create",
					groupId: G,
					inviteId: "id1",
					token: "T".repeat(43),
					claimMemberId: null,
					expiresAt: "2026-11-18T18:00:00.000Z",
				},
			],
		});
		for (const claim of ["mem", "left", "nobody"]) {
			expect(
				planChange(state("owner"), { groupId: G, type: "createInvite", claimMemberId: claim }, ctx())
			).toMatchObject({
				code: "HS422",
			});
		}
	});

	test("revokeInvite: a member may revoke their own only; revoking twice plans nothing", () => {
		expect(planChange(state("member"), { groupId: G, type: "revokeInvite", inviteId: "inv-mem" }, ctx())).toMatchObject(
			{
				mutations: [{ type: "invite.revoke", inviteId: "inv-mem" }],
			}
		);
		expect(planChange(state("member"), { groupId: G, type: "revokeInvite", inviteId: "inv-o" }, ctx())).toMatchObject({
			code: "HS403",
		});
		const revoked = state("owner", { invites: [invite("inv-o", "u-o", { revokedAt: NOW })] });
		expect(planChange(revoked, { groupId: G, type: "revokeInvite", inviteId: "inv-o" }, ctx())).toMatchObject({
			ok: true,
			mutations: [],
		});
	});
});

describe("planChange: handshakes", () => {
	const record = (from: string, to: string, amountCents = 500): Intent => ({
		groupId: G,
		type: "recordPayment",
		from,
		to,
		amountCents,
		entryDate: "2026-11-04",
		notes: null,
	});

	test("the payer or the receiver can record", () => {
		expect(planChange(state("member"), record("mem", "o"), ctx())).toEqual({
			ok: true,
			createdId: "id1",
			mutations: [
				{
					id: "id2",
					at: NOW,
					type: "payment.record",
					groupId: G,
					entryId: "id1",
					fromMemberId: "mem",
					toMemberId: "o",
					amountCents: 500,
					entryDate: "2026-11-04",
					notes: null,
				},
			],
		});
		expect(planChange(state("member"), record("o", "mem"), ctx())).toMatchObject({ ok: true });
	});

	test("between two name-only people a member can record and a guest can't", () => {
		expect(planChange(state("member"), record("n1", "n2"), ctx())).toMatchObject({ ok: true });
		expect(planChange(state("guest"), record("n1", "n2"), ctx())).toMatchObject({ ok: false, code: "HS403" });
		// Someone who left can't answer either.
		expect(planChange(state("member"), record("left", "n2"), ctx())).toMatchObject({ ok: true });
		// But not for two people who can answer for themselves.
		expect(planChange(state("owner"), record("mem", "g"), ctx())).toMatchObject({ ok: false, code: "HS422" });
	});

	test("bad payments are HS422", () => {
		const s = state("owner");
		expect(planChange(s, record("o", "o"), ctx())).toMatchObject({ code: "HS422" });
		expect(planChange(s, record("o", "nobody"), ctx())).toMatchObject({ code: "HS422" });
		expect(planChange(s, record("o", "mem", 0), ctx())).toMatchObject({ code: "HS422" });
		expect(planChange(s, record("o", "mem", 2.5), ctx())).toMatchObject({ code: "HS422" });
		expect(planChange(s, { ...record("o", "mem"), entryDate: "soon" } as Intent, ctx())).toMatchObject({
			code: "HS422",
		});
	});

	test("one pending payment per pair, either way round", () => {
		const s = state("owner", { entries: [pendingPayment("p", "mem", "o", "mem")] });
		expect(planChange(s, record("o", "mem"), ctx())).toMatchObject({ ok: false, code: "HS409" });
		expect(planChange(s, record("mem", "o"), ctx())).toMatchObject({ ok: false, code: "HS409" });
		expect(planChange(s, record("o", "n1"), ctx())).toMatchObject({ ok: true });
	});

	test("only the other side can confirm or decline", () => {
		const s = state("owner", { entries: [pendingPayment("p", "mem", "o", "mem")] });
		expect(planChange(s, { groupId: G, type: "confirmPayment", entryId: "p" }, ctx())).toMatchObject({
			mutations: [{ type: "payment.confirm", entryId: "p" }],
		});
		expect(
			planChange(s, { groupId: G, type: "declinePayment", entryId: "p", note: "  Not yet  " }, ctx())
		).toMatchObject({
			mutations: [{ type: "payment.decline", entryId: "p", note: "Not yet" }],
		});
		expect(planChange(s, { groupId: G, type: "declinePayment", entryId: "p", note: "  " }, ctx())).toMatchObject({
			mutations: [{ note: null }],
		});
		expect(
			planChange(s, { groupId: G, type: "declinePayment", entryId: "p", note: "x".repeat(201) }, ctx())
		).toMatchObject({ code: "HS422" });

		const starter = state("member", { entries: [pendingPayment("p", "mem", "o", "mem")] });
		expect(planChange(starter, { groupId: G, type: "confirmPayment", entryId: "p" }, ctx())).toMatchObject({
			code: "HS403",
		});
		const outsider = state("guest", { entries: [pendingPayment("p", "mem", "o", "mem")] });
		expect(planChange(outsider, { groupId: G, type: "declinePayment", entryId: "p", note: null }, ctx())).toMatchObject(
			{ code: "HS403" }
		);
	});

	test("only the starter can undo", () => {
		const s = state("owner", { entries: [pendingPayment("p", "mem", "o", "mem")] });
		expect(planChange(s, { groupId: G, type: "undoPayment", entryId: "p" }, ctx())).toMatchObject({
			ok: false,
			code: "HS403",
		});
		const starter = state("member", { entries: [pendingPayment("p", "mem", "o", "mem")] });
		expect(planChange(starter, { groupId: G, type: "undoPayment", entryId: "p" }, ctx())).toMatchObject({
			mutations: [{ type: "payment.undo", entryId: "p" }],
		});
	});

	test("answering the same way twice plans nothing (a double tap)", () => {
		const confirmed = {
			...pendingPayment("p", "mem", "o", "mem"),
			paymentStatus: "confirmed" as const,
			updatedByMemberId: "o",
		};
		const declined = {
			...pendingPayment("q", "mem", "o", "mem"),
			paymentStatus: "declined" as const,
			updatedByMemberId: "o",
		};
		const undone = {
			...pendingPayment("r", "o", "mem", "o"),
			paymentStatus: "undone" as const,
			updatedByMemberId: "o",
		};
		const s = state("owner", { entries: [confirmed, declined, undone] });
		const none = { ok: true as const, mutations: [], createdId: null };
		expect(planChange(s, { groupId: G, type: "confirmPayment", entryId: "p" }, ctx())).toEqual(none);
		expect(planChange(s, { groupId: G, type: "declinePayment", entryId: "q", note: null }, ctx())).toEqual(none);
		expect(planChange(s, { groupId: G, type: "undoPayment", entryId: "r" }, ctx())).toEqual(none);
	});

	test("answering a payment someone else already answered is HS409", () => {
		const undone = { ...pendingPayment("p", "mem", "o", "mem"), paymentStatus: "undone" as const };
		const s = state("owner", { entries: [undone] });
		expect(planChange(s, { groupId: G, type: "confirmPayment", entryId: "p" }, ctx())).toEqual({
			ok: false,
			code: "HS409",
			reason: "Max undid this payment",
		});
		const confirmed = {
			...pendingPayment("p", "o", "mem", "o"),
			paymentStatus: "confirmed" as const,
			updatedByMemberId: "mem",
		};
		expect(
			planChange(state("owner", { entries: [confirmed] }), { groupId: G, type: "undoPayment", entryId: "p" }, ctx())
		).toMatchObject({
			code: "HS409",
		});
	});

	test("a bill isn't a payment, and an unknown entry isn't in the group", () => {
		const s = state("owner");
		expect(planChange(s, { groupId: G, type: "confirmPayment", entryId: "b-mem" }, ctx())).toMatchObject({
			code: "HS422",
		});
		expect(planChange(s, { groupId: G, type: "confirmPayment", entryId: "nope" }, ctx())).toMatchObject({
			code: "HS422",
		});
	});
});

describe("planChange is pure", () => {
	test("the same inputs give the same plan", () => {
		const s = state("owner");
		const intent: Intent = { groupId: G, type: "addExpense", draft: draft() };
		const before = structuredClone(s);
		expect(planChange(s, intent, ctx())).toEqual(planChange(s, intent, ctx()));
		expect(s).toEqual(before);
	});
});
