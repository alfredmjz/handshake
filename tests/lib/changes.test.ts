import { describe, expect, test } from "bun:test";

import {
	canAnswer,
	paymentCountsAtOnce,
	pendingPaymentBetween,
	planChange,
	type ExpenseDraft,
	type GroupIntent,
	type GroupState,
	type Intent,
	type PlanContext,
} from "@/lib/changes";
import type { ConflictRow, EntryRow, InviteRow, MemberRow } from "@/lib/sync/types";
import { serverBill, serverGroup, serverMember } from "../support/memory-tables";

const G = "g1";
const NOW = "2026-11-08T10:00:00.000Z";
const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"; // 43 characters

const member = (id: string, overrides: Partial<MemberRow>) => serverMember({ id, groupId: G, ...overrides });

// Alex owns the group, Sam is a member, Gus a guest; Jo and Nina were added by name; Kim left.
const MEMBERS: MemberRow[] = [
	member("alex", { userId: "user-a", displayName: "Alex", role: "owner" }),
	member("sam", { userId: "user-s", displayName: "Sam", role: "member" }),
	member("gus", { userId: "user-g", displayName: "Gus", role: "guest" }),
	member("jo", { userId: null, displayName: "Jo", role: "member", joinedAt: null }),
	member("nina", { userId: null, displayName: "Nina", role: "member", joinedAt: null }),
	member("kim", { userId: "user-k", displayName: "Kim", role: "member", deletedAt: "2026-11-02T00:00:00.000Z" }),
];

function payment(id: string, from: string, to: string, overrides: Partial<EntryRow> = {}): EntryRow {
	return serverBill({
		id,
		groupId: G,
		createdByMemberId: from,
		kind: "payment",
		description: "Payment",
		amountCents: 500,
		items: null,
		paymentStatus: "pending",
		payerConfirmedAt: "2026-11-02T00:00:00.000Z",
		shares: [
			{ memberId: to, paidCents: 0, owedCents: 500, owedTo: { [from]: 500 } },
			{ memberId: from, paidCents: 500, owedCents: 0, owedTo: {} },
		],
		...overrides,
	});
}

const invite = (id: string, createdBy: string): InviteRow => ({
	id,
	groupId: G,
	claimMemberId: null,
	createdBy,
	createdAt: "2026-11-02T00:00:00.000Z",
	expiresAt: "2026-11-16T00:00:00.000Z",
	revokedAt: null,
	rowVersion: 3,
});

const conflict = (overrides: Partial<ConflictRow> = {}): ConflictRow => ({
	id: "c1",
	groupId: G,
	entryId: "bill-alex",
	baseVersion: 1,
	base: null,
	proposed: null,
	proposedByMemberId: "sam",
	createdAt: "2026-11-03T00:00:00.000Z",
	resolvedAt: null,
	resolvedByMemberId: null,
	resolution: null,
	rowVersion: 5,
	...overrides,
});

// Each of Alex, Sam and Gus has a bill and an invite of their own (Gus can't make invites, so none), one
// pending payment to answer and one to undo: sam→alex (Sam's), gus→sam (Gus's), alex→gus (Alex's).
function state(as: "alex" | "sam" | "gus", overrides: Partial<GroupState> = {}): GroupState {
	const me = MEMBERS.find((m) => m.id === as)!;
	return {
		group: serverGroup({ id: G, createdBy: "user-a" }),
		members: MEMBERS,
		entries: [
			serverBill({ id: "bill-alex", groupId: G, createdByMemberId: "alex", rowVersion: 4 }),
			serverBill({ id: "bill-sam", groupId: G, createdByMemberId: "sam", rowVersion: 6 }),
			serverBill({ id: "bill-gus", groupId: G, createdByMemberId: "gus", rowVersion: 7 }),
			payment("p-sam-alex", "sam", "alex"),
			payment("p-gus-sam", "gus", "sam"),
			payment("p-alex-gus", "alex", "gus"),
		],
		conflicts: [conflict()],
		invites: [invite("inv-alex", "user-a"), invite("inv-sam", "user-s")],
		me: { memberId: me.id, role: me.role, isAnonymous: me.role === "guest" },
		...overrides,
	};
}

function context(overrides: Partial<PlanContext> = {}): PlanContext {
	let n = 0;
	return {
		newId: () => `id-${++n}`,
		randomToken: () => TOKEN,
		now: NOW,
		today: "2026-11-08",
		isAnonymous: false,
		...overrides,
	};
}

const plan = (s: GroupState | null, intent: GroupIntent | Intent, ctx = context()) =>
	planChange(
		s,
		("groupId" in intent || intent.type === "createGroup" ? intent : { groupId: G, ...intent }) as Intent,
		ctx
	);

const draft = (overrides: Partial<ExpenseDraft> = {}): ExpenseDraft => ({
	description: "Dinner",
	entryDate: "2026-11-07",
	notes: null,
	category: null,
	items: [{ id: "i1", amountCents: 3000, paidBy: "alex", splitAmong: ["alex", "sam", "gus"] }],
	...overrides,
});

// Dinner 30.00 paid by Alex, split three ways: each owes 10.00 to Alex.
const DINNER_SHARES = [
	{ memberId: "alex", paidCents: 3000, owedCents: 1000, owedTo: { alex: 1000 } },
	{ memberId: "sam", paidCents: 0, owedCents: 1000, owedTo: { alex: 1000 } },
	{ memberId: "gus", paidCents: 0, owedCents: 1000, owedTo: { alex: 1000 } },
];

type Actor = "alex" | "sam" | "gus";
const others: Record<Actor, Actor> = { alex: "sam", sam: "alex", gus: "alex" };
const toAnswer: Record<Actor, string> = { alex: "p-sam-alex", sam: "p-gus-sam", gus: "p-alex-gus" };
const toUndo: Record<Actor, string> = { alex: "p-alex-gus", sam: "p-sam-alex", gus: "p-gus-sam" };

// Spec decision 8, one row per intent: [owner, member, guest] allowed, and allowed in a completed group.
const MATRIX: [string, (as: Actor) => GroupIntent, [boolean, boolean, boolean], boolean][] = [
	["renameGroup", () => ({ type: "renameGroup", name: "Japan" }), [true, false, false], false],
	["describeGroup", () => ({ type: "describeGroup", note: "Tokyo" }), [true, false, false], false],
	["deleteGroup", () => ({ type: "deleteGroup" }), [true, false, false], true],
	["completeGroup", () => ({ type: "completeGroup" }), [true, false, false], false],
	["addPerson", () => ({ type: "addPerson", displayName: "Lee" }), [true, true, false], false],
	[
		"renamePerson (self)",
		(as) => ({ type: "renamePerson", memberId: as, displayName: "Me" }),
		[true, true, true],
		false,
	],
	[
		"renamePerson (others)",
		() => ({ type: "renamePerson", memberId: "jo", displayName: "Joanne" }),
		[true, false, false],
		false,
	],
	["removePerson (leave)", (as) => ({ type: "removePerson", memberId: as }), [true, true, true], true],
	["removePerson (others)", () => ({ type: "removePerson", memberId: "jo" }), [true, false, false], false],
	["addExpense", () => ({ type: "addExpense", draft: draft() }), [true, true, true], false],
	["editExpense", (as) => ({ type: "editExpense", entryId: `bill-${as}`, draft: draft() }), [true, true, false], false],
	["deleteEntry (own)", (as) => ({ type: "deleteEntry", entryId: `bill-${as}` }), [true, true, true], false],
	[
		"deleteEntry (others)",
		(as) => ({ type: "deleteEntry", entryId: `bill-${others[as]}` }),
		[true, true, false],
		false,
	],
	[
		"resolveConflict",
		() => ({ type: "resolveConflict", conflictId: "c1", resolution: "kept_current", final: draft() }),
		[true, true, false],
		false,
	],
	["createInvite", () => ({ type: "createInvite", claimMemberId: null }), [true, true, false], false],
	["revokeInvite (own)", (as) => ({ type: "revokeInvite", inviteId: `inv-${as}` }), [true, true, false], false],
	[
		"revokeInvite (others)",
		(as) => ({ type: "revokeInvite", inviteId: `inv-${others[as]}` }),
		[true, false, false],
		false,
	],
	[
		"recordPayment (own)",
		(as) => ({ type: "recordPayment", from: as, to: "jo", amountCents: 1000, entryDate: "2026-11-08", notes: null }),
		[true, true, true],
		false,
	],
	[
		"recordPayment (others)",
		() => ({ type: "recordPayment", from: "jo", to: "nina", amountCents: 1000, entryDate: "2026-11-08", notes: null }),
		[true, true, false],
		false,
	],
	["confirmPayment", (as) => ({ type: "confirmPayment", entryId: toAnswer[as] }), [true, true, true], true],
	["declinePayment", (as) => ({ type: "declinePayment", entryId: toAnswer[as], note: null }), [true, true, true], true],
	["undoPayment", (as) => ({ type: "undoPayment", entryId: toUndo[as] }), [true, true, true], false],
];

describe("planChange: role matrix", () => {
	const actors: Actor[] = ["alex", "sam", "gus"];
	for (const [name, intentFor, allowed, whenCompleted] of MATRIX) {
		for (const [i, as] of actors.entries()) {
			test(`${name} as ${state(as).me.role}`, () => {
				const result = plan(state(as), intentFor(as));
				if (allowed[i]) {
					expect(result).toMatchObject({ ok: true });
					if (result.ok) expect(result.mutations.length).toBe(1);
				} else {
					expect(result).toMatchObject({ ok: false, code: "HS403" });
				}
			});
			test(`${name} as ${state(as).me.role} in a completed group`, () => {
				const completed = state(as, { group: serverGroup({ id: G, completedAt: NOW, completedByMemberId: "alex" }) });
				const result = plan(completed, intentFor(as));
				if (allowed[i] && whenCompleted) expect(result).toMatchObject({ ok: true });
				else
					expect(result).toEqual({
						ok: false,
						code: "HS403",
						reason: allowed[i] ? "This group is completed" : expect.any(String),
					});
			});
		}
	}

	test("reopenGroup: owner only, and only does something in a completed group", () => {
		const completed = (as: Actor) =>
			state(as, { group: serverGroup({ id: G, completedAt: NOW, completedByMemberId: "alex" }) });
		expect(plan(completed("alex"), { type: "reopenGroup" })).toMatchObject({
			ok: true,
			mutations: [{ type: "group.reopen" }],
		});
		expect(plan(completed("sam"), { type: "reopenGroup" })).toMatchObject({ ok: false, code: "HS403" });
		expect(plan(completed("gus"), { type: "reopenGroup" })).toMatchObject({ ok: false, code: "HS403" });
		expect(plan(state("alex"), { type: "reopenGroup" })).toEqual({ ok: true, mutations: [], createdId: null });
	});

	test("the role refusal names who may", () => {
		expect(plan(state("sam"), { type: "renameGroup", name: "X" })).toEqual({
			ok: false,
			code: "HS403",
			reason: "Only the group's owner can do this",
		});
		expect(plan(state("gus"), { type: "addPerson", displayName: "Lee" })).toEqual({
			ok: false,
			code: "HS403",
			reason: "Guests can't do this",
		});
	});

	test("checks run in the server's order: member, deleted, completed, role", () => {
		expect(plan(null, { type: "addPerson", displayName: "Lee" })).toEqual({
			ok: false,
			code: "HS403",
			reason: "You are not a member of this group",
		});
		const deletedAndCompleted = state("gus", {
			group: serverGroup({ id: G, deletedAt: NOW, completedAt: NOW, completedByMemberId: "alex" }),
		});
		expect(plan(deletedAndCompleted, { type: "addPerson", displayName: "Lee" })).toMatchObject({
			reason: "This group was deleted",
		});
		const completed = state("gus", { group: serverGroup({ id: G, completedAt: NOW, completedByMemberId: "alex" }) });
		expect(plan(completed, { type: "addPerson", displayName: "Lee" })).toMatchObject({
			reason: "This group is completed",
		});
		// The role check comes before the intent's own checks.
		expect(plan(state("gus"), { type: "addPerson", displayName: "" })).toMatchObject({
			reason: "Guests can't do this",
		});
	});
});

describe("planChange: mutations", () => {
	const at = NOW;

	test("createGroup", () => {
		expect(plan(null, { type: "createGroup", name: " Japan 2027 ", displayName: "alex" })).toEqual({
			ok: true,
			createdId: "id-1",
			mutations: [
				{
					id: "id-3",
					at,
					type: "group.create",
					groupId: "id-1",
					memberId: "id-2",
					name: "Japan 2027",
					displayName: "alex",
					note: null,
				},
			],
		});
	});

	test("createGroup is refused for guests", () => {
		expect(
			plan(null, { type: "createGroup", name: "Japan", displayName: "Me" }, context({ isAnonymous: true }))
		).toEqual({
			ok: false,
			code: "HS403",
			reason: "Guests can't create groups",
		});
	});

	test("group names and display names are 1 to 80 and 1 to 60 characters", () => {
		expect(plan(null, { type: "createGroup", name: "  ", displayName: "Me" })).toEqual({
			ok: false,
			code: "HS422",
			reason: "A group name must be 1 to 80 characters",
		});
		expect(plan(state("alex"), { type: "renameGroup", name: "x".repeat(81) })).toMatchObject({ code: "HS422" });
		expect(plan(state("alex"), { type: "renameGroup", name: "x".repeat(80) })).toMatchObject({ ok: true });
		expect(plan(state("alex"), { type: "addPerson", displayName: "x".repeat(61) })).toEqual({
			ok: false,
			code: "HS422",
			reason: "A name must be 1 to 60 characters",
		});
		expect(plan(state("alex"), { type: "renamePerson", memberId: "jo", displayName: " " })).toMatchObject({
			code: "HS422",
		});
	});

	test("renameGroup, deleteGroup, completeGroup", () => {
		expect(plan(state("alex"), { type: "renameGroup", name: "Kyoto " })).toEqual({
			ok: true,
			createdId: null,
			mutations: [{ id: "id-1", at, type: "group.rename", groupId: G, name: "Kyoto" }],
		});
		expect(plan(state("alex"), { type: "deleteGroup" })).toMatchObject({
			mutations: [{ id: "id-1", at, type: "group.delete", groupId: G }],
		});
		expect(plan(state("alex"), { type: "completeGroup" })).toMatchObject({
			mutations: [{ id: "id-1", at, type: "group.complete", groupId: G }],
		});
	});

	test("addPerson names the new person", () => {
		expect(plan(state("sam"), { type: "addPerson", displayName: " Lee " })).toEqual({
			ok: true,
			createdId: "id-1",
			mutations: [{ id: "id-2", at, type: "member.add", groupId: G, memberId: "id-1", displayName: "Lee" }],
		});
	});

	test("renamePerson and removePerson", () => {
		expect(plan(state("gus"), { type: "renamePerson", memberId: "gus", displayName: "Gussie" })).toEqual({
			ok: true,
			createdId: null,
			mutations: [{ id: "id-1", at, type: "member.rename", groupId: G, memberId: "gus", displayName: "Gussie" }],
		});
		expect(plan(state("alex"), { type: "renamePerson", memberId: "nobody", displayName: "X" })).toEqual({
			ok: false,
			code: "HS422",
			reason: "That person is not in this group",
		});
		expect(plan(state("alex"), { type: "removePerson", memberId: "jo" })).toEqual({
			ok: true,
			createdId: null,
			mutations: [{ id: "id-1", at, type: "member.remove", groupId: G, memberId: "jo" }],
		});
		// Leaving is removing yourself.
		expect(plan(state("gus"), { type: "removePerson", memberId: "gus" })).toMatchObject({
			mutations: [{ type: "member.remove", memberId: "gus" }],
		});
		expect(plan(state("alex"), { type: "removePerson", memberId: "nobody" })).toMatchObject({ code: "HS422" });
		// Kim has left already: nothing to do, as on the server.
		expect(plan(state("alex"), { type: "removePerson", memberId: "kim" })).toEqual({
			ok: true,
			mutations: [],
			createdId: null,
		});
	});

	test("addExpense derives the amount and shares from the items", () => {
		expect(
			plan(state("gus"), { type: "addExpense", draft: draft({ description: " Dinner ", notes: "Ramen" }) })
		).toEqual({
			ok: true,
			createdId: "id-1",
			mutations: [
				{
					id: "id-2",
					at,
					type: "entry.create",
					groupId: G,
					entryId: "id-1",
					description: "Dinner",
					amountCents: 3000,
					entryDate: "2026-11-07",
					notes: "Ramen",
					category: null,
					items: draft().items,
					shares: DINNER_SHARES,
				},
			],
		});
	});

	test("addExpense: a blank note is no note", () => {
		const result = plan(state("alex"), { type: "addExpense", draft: draft({ notes: "  " }) });
		expect(result.ok && result.mutations[0]).toMatchObject({ notes: null });
	});

	test("editExpense carries the entry's rowVersion as baseVersion", () => {
		expect(plan(state("sam"), { type: "editExpense", entryId: "bill-alex", draft: draft() })).toEqual({
			ok: true,
			createdId: null,
			mutations: [
				{
					id: "id-1",
					at,
					type: "entry.update",
					groupId: G,
					entryId: "bill-alex",
					baseVersion: 4,
					description: "Dinner",
					amountCents: 3000,
					entryDate: "2026-11-07",
					notes: null,
					category: null,
					items: draft().items,
					shares: DINNER_SHARES,
				},
			],
		});
	});

	test("deleteEntry carries baseVersion; deleted or unknown bills need nothing", () => {
		expect(plan(state("gus"), { type: "deleteEntry", entryId: "bill-gus" })).toEqual({
			ok: true,
			createdId: null,
			mutations: [{ id: "id-1", at, type: "entry.delete", groupId: G, entryId: "bill-gus", baseVersion: 7 }],
		});
		const deleted = state("alex");
		deleted.entries = deleted.entries.map((e) => (e.id === "bill-alex" ? { ...e, deletedAt: NOW } : e));
		expect(plan(deleted, { type: "deleteEntry", entryId: "bill-alex" })).toEqual({
			ok: true,
			mutations: [],
			createdId: null,
		});
		expect(plan(state("alex"), { type: "deleteEntry", entryId: "nope" })).toEqual({
			ok: true,
			mutations: [],
			createdId: null,
		});
		expect(plan(state("alex"), { type: "editExpense", entryId: "nope", draft: draft() })).toEqual({
			ok: true,
			mutations: [],
			createdId: null,
		});
	});

	test("payments can't be edited or deleted", () => {
		const reason = "A payment can't be edited or deleted; record one the other way instead";
		expect(plan(state("alex"), { type: "editExpense", entryId: "p-sam-alex", draft: draft() })).toEqual({
			ok: false,
			code: "HS422",
			reason,
		});
		expect(plan(state("alex"), { type: "deleteEntry", entryId: "p-sam-alex" })).toEqual({
			ok: false,
			code: "HS422",
			reason,
		});
	});

	test("resolveConflict sends the final bill or deleted", () => {
		expect(
			plan(state("sam"), { type: "resolveConflict", conflictId: "c1", resolution: "merged", final: draft() })
		).toEqual({
			ok: true,
			createdId: null,
			mutations: [
				{
					id: "id-1",
					at,
					type: "conflict.resolve",
					groupId: G,
					conflictId: "c1",
					entryId: "bill-alex",
					resolution: "merged",
					entry: {
						description: "Dinner",
						amountCents: 3000,
						entryDate: "2026-11-07",
						notes: null,
						category: null,
						items: draft().items,
						shares: DINNER_SHARES,
					},
				},
			],
		});
		expect(
			plan(state("alex"), { type: "resolveConflict", conflictId: "c1", resolution: "took_proposed", final: "deleted" })
		).toMatchObject({ mutations: [{ type: "conflict.resolve", entry: { deleted: true } }] });
	});

	test("resolveConflict refusals", () => {
		const resolved = state("alex", {
			conflicts: [conflict({ resolvedAt: NOW, resolvedByMemberId: "sam", resolution: "kept_current" })],
		});
		expect(
			plan(resolved, { type: "resolveConflict", conflictId: "c1", resolution: "merged", final: "deleted" })
		).toEqual({
			ok: false,
			code: "HS409",
			reason: "Sam already resolved this",
		});
		expect(
			plan(state("alex"), { type: "resolveConflict", conflictId: "c9", resolution: "merged", final: "deleted" })
		).toEqual({
			ok: false,
			code: "HS422",
			reason: "That conflict doesn't exist in this group",
		});
		expect(
			plan(state("alex"), {
				type: "resolveConflict",
				conflictId: "c1",
				resolution: "merged",
				final: draft({ description: "" }),
			})
		).toEqual({ ok: false, code: "HS422", reason: "The description must be 1 to 120 characters" });
	});

	test("createInvite: token from ctx, 14 days, the new invite's id", () => {
		expect(plan(state("sam"), { type: "createInvite", claimMemberId: "jo" })).toEqual({
			ok: true,
			createdId: "id-1",
			mutations: [
				{
					id: "id-2",
					at,
					type: "invite.create",
					groupId: G,
					inviteId: "id-1",
					token: TOKEN,
					claimMemberId: "jo",
					expiresAt: "2026-11-22T10:00:00.000Z",
				},
			],
		});
	});

	test("createInvite refusals", () => {
		const reason = "An invite can only be for someone in this group who hasn't joined";
		expect(plan(state("alex"), { type: "createInvite", claimMemberId: "sam" })).toEqual({
			ok: false,
			code: "HS422",
			reason,
		});
		expect(plan(state("alex"), { type: "createInvite", claimMemberId: "nobody" })).toEqual({
			ok: false,
			code: "HS422",
			reason,
		});
		expect(
			plan(state("alex"), { type: "createInvite", claimMemberId: null }, context({ randomToken: () => "short" }))
		).toEqual({
			ok: false,
			code: "HS422",
			reason: "An invite token must be 32 random bytes in base64url",
		});
	});

	test("revokeInvite; unknown or revoked links need nothing", () => {
		expect(plan(state("sam"), { type: "revokeInvite", inviteId: "inv-sam" })).toEqual({
			ok: true,
			createdId: null,
			mutations: [{ id: "id-1", at, type: "invite.revoke", groupId: G, inviteId: "inv-sam" }],
		});
		expect(plan(state("sam"), { type: "revokeInvite", inviteId: "nope" })).toEqual({
			ok: true,
			mutations: [],
			createdId: null,
		});
		const revoked = state("alex", { invites: [{ ...invite("inv-alex", "user-a"), revokedAt: NOW }] });
		expect(plan(revoked, { type: "revokeInvite", inviteId: "inv-alex" })).toEqual({
			ok: true,
			mutations: [],
			createdId: null,
		});
	});
});

describe("planChange: payments", () => {
	const at = NOW;
	const record = (from: string, to: string, extra: Partial<Extract<GroupIntent, { type: "recordPayment" }>> = {}) =>
		({ type: "recordPayment", from, to, amountCents: 1000, entryDate: "2026-11-08", notes: null, ...extra }) as const;
	const noPending = (as: Actor) => state(as, { entries: state(as).entries.filter((e) => e.kind !== "payment") });

	test("recordPayment", () => {
		expect(plan(noPending("sam"), record("sam", "alex", { notes: "Thanks" }))).toEqual({
			ok: true,
			createdId: "id-1",
			mutations: [
				{
					id: "id-2",
					at,
					type: "payment.record",
					groupId: G,
					entryId: "id-1",
					fromMemberId: "sam",
					toMemberId: "alex",
					amountCents: 1000,
					entryDate: "2026-11-08",
					notes: "Thanks",
				},
			],
		});
	});

	test("one pending payment per pair, either way round (HS409)", () => {
		const reason = "A payment between these two is already waiting for an answer";
		// p-sam-alex is pending.
		expect(plan(state("sam"), record("sam", "alex"))).toEqual({ ok: false, code: "HS409", reason });
		expect(plan(state("alex"), record("alex", "sam"))).toEqual({ ok: false, code: "HS409", reason });
		// Once it is answered, the pair can record again.
		const answered = state("alex");
		answered.entries = answered.entries.map((e) => (e.id === "p-sam-alex" ? { ...e, paymentStatus: "confirmed" } : e));
		expect(plan(answered, record("alex", "sam"))).toMatchObject({ ok: true });
	});

	test("recordPayment refusals, in the server's order", () => {
		expect(plan(noPending("alex"), record("alex", "nobody"))).toEqual({
			ok: false,
			code: "HS422",
			reason: "Both sides of a payment must be in this group",
		});
		expect(plan(noPending("alex"), record("alex", "alex"))).toEqual({
			ok: false,
			code: "HS422",
			reason: "A payment is between two different people",
		});
		// A full member records for others only when neither side can answer.
		expect(plan(noPending("alex"), record("jo", "sam"))).toEqual({
			ok: false,
			code: "HS422",
			reason: "You can only record payments between two people who can't answer them themselves",
		});
		expect(plan(noPending("alex"), record("jo", "kim"))).toMatchObject({ ok: true });
		expect(plan(noPending("alex"), record("alex", "jo", { amountCents: 0 }))).toEqual({
			ok: false,
			code: "HS422",
			reason: "The amount must be a whole number of cents from 1 to 10^12",
		});
		expect(plan(noPending("alex"), record("alex", "jo", { amountCents: 10.5 }))).toMatchObject({ code: "HS422" });
		expect(plan(noPending("alex"), record("alex", "jo", { entryDate: "8 Nov" }))).toEqual({
			ok: false,
			code: "HS422",
			reason: "The date must be YYYY-MM-DD",
		});
		expect(plan(noPending("alex"), record("alex", "jo", { entryDate: "2026-02-30" }))).toEqual({
			ok: false,
			code: "HS422",
			reason: "The date must be a real day",
		});
		expect(plan(noPending("alex"), record("alex", "jo", { notes: "x".repeat(1001) }))).toEqual({
			ok: false,
			code: "HS422",
			reason: "Notes must be text of at most 1000 characters",
		});
	});

	test("counts at once when the other side can't answer", () => {
		const alex = state("alex");
		expect(canAnswer(MEMBERS.find((m) => m.id === "sam"))).toBe(true);
		expect(canAnswer(MEMBERS.find((m) => m.id === "jo"))).toBe(false); // no login
		expect(canAnswer(MEMBERS.find((m) => m.id === "kim"))).toBe(false); // left
		expect(paymentCountsAtOnce(alex, "alex", "sam")).toBe(false);
		expect(paymentCountsAtOnce(alex, "sam", "alex")).toBe(false);
		expect(paymentCountsAtOnce(alex, "alex", "jo")).toBe(true);
		expect(paymentCountsAtOnce(alex, "kim", "alex")).toBe(true);
		expect(paymentCountsAtOnce(alex, "jo", "nina")).toBe(true);
	});

	test("pendingPaymentBetween finds it either way round", () => {
		const entries = state("alex").entries;
		expect(pendingPaymentBetween(entries, "alex", "sam")?.id).toBe("p-sam-alex");
		expect(pendingPaymentBetween(entries, "sam", "alex")?.id).toBe("p-sam-alex");
		expect(pendingPaymentBetween(entries, "jo", "alex")).toBeUndefined();
	});

	test("confirm, decline and undo", () => {
		expect(plan(state("alex"), { type: "confirmPayment", entryId: "p-sam-alex" })).toEqual({
			ok: true,
			createdId: null,
			mutations: [{ id: "id-1", at, type: "payment.confirm", groupId: G, entryId: "p-sam-alex" }],
		});
		expect(plan(state("alex"), { type: "declinePayment", entryId: "p-sam-alex", note: "Not yet" })).toEqual({
			ok: true,
			createdId: null,
			mutations: [{ id: "id-1", at, type: "payment.decline", groupId: G, entryId: "p-sam-alex", note: "Not yet" }],
		});
		expect(plan(state("sam"), { type: "undoPayment", entryId: "p-sam-alex" })).toEqual({
			ok: true,
			createdId: null,
			mutations: [{ id: "id-1", at, type: "payment.undo", groupId: G, entryId: "p-sam-alex" }],
		});
	});

	test("answering is idempotent once the payment isn't pending", () => {
		for (const status of ["confirmed", "declined", "undone"] as const) {
			const answered = state("alex");
			answered.entries = answered.entries.map((e) => (e.paymentStatus ? { ...e, paymentStatus: status } : e));
			const none = { ok: true as const, mutations: [], createdId: null };
			expect(plan(answered, { type: "confirmPayment", entryId: "p-sam-alex" })).toEqual(none);
			expect(plan(answered, { type: "declinePayment", entryId: "p-sam-alex", note: null })).toEqual(none);
			expect(plan(answered, { type: "undoPayment", entryId: "p-alex-gus" })).toEqual(none);
		}
		// A payment this device never got: accepted and nothing to do, as on the server.
		expect(plan(state("alex"), { type: "confirmPayment", entryId: "nope" })).toEqual({
			ok: true,
			mutations: [],
			createdId: null,
		});
	});

	test("answer and undo refusals", () => {
		// Alex recorded p-alex-gus, so it is Gus's to answer.
		expect(plan(state("alex"), { type: "confirmPayment", entryId: "p-alex-gus" })).toEqual({
			ok: false,
			code: "HS403",
			reason: "Only the other side of this payment can answer it",
		});
		// Sam isn't a side of p-alex-gus.
		expect(plan(state("sam"), { type: "declinePayment", entryId: "p-alex-gus", note: null })).toMatchObject({
			code: "HS403",
		});
		expect(plan(state("alex"), { type: "undoPayment", entryId: "p-sam-alex" })).toEqual({
			ok: false,
			code: "HS403",
			reason: "Only whoever recorded this payment can undo it",
		});
		expect(plan(state("alex"), { type: "confirmPayment", entryId: "bill-sam" })).toEqual({
			ok: false,
			code: "HS422",
			reason: "That is a bill, not a payment",
		});
		expect(plan(state("alex"), { type: "declinePayment", entryId: "p-sam-alex", note: "x".repeat(201) })).toEqual({
			ok: false,
			code: "HS422",
			reason: "A note must be text of at most 200 characters",
		});
	});
});

describe("planChange: text and dates as Postgres reads them", () => {
	const emoji = (n: number) => "\u{1F600}".repeat(n); // 2 UTF-16 units, 1 code point each
	const noPending = () => state("alex", { entries: state("alex").entries.filter((e) => e.kind !== "payment") });
	const record = (extra: object) =>
		({
			type: "recordPayment",
			from: "alex",
			to: "jo",
			amountCents: 100,
			entryDate: "2026-11-08",
			notes: null,
			...extra,
		}) as const;
	const decline = (note: string | null) => plan(state("alex"), { type: "declinePayment", entryId: "p-sam-alex", note });

	test("lengths count code points", () => {
		expect(plan(noPending(), record({ notes: emoji(1000) }))).toMatchObject({ ok: true });
		expect(plan(noPending(), record({ notes: emoji(1001) }))).toMatchObject({ code: "HS422" });
		expect(decline(emoji(200))).toMatchObject({ ok: true });
		expect(decline(emoji(201))).toMatchObject({ code: "HS422" });
		expect(
			plan(state("alex"), { type: "addExpense", draft: draft({ description: emoji(120), notes: emoji(1000) }) })
		).toMatchObject({
			ok: true,
		});
		expect(plan(state("alex"), { type: "renameGroup", name: emoji(80) })).toMatchObject({ ok: true });
	});

	test("years 0001 to 0099 are real days; year 0 is not", () => {
		expect(plan(noPending(), record({ entryDate: "0050-01-01" }))).toMatchObject({ ok: true });
		expect(plan(noPending(), record({ entryDate: "0000-01-01" }))).toEqual({
			ok: false,
			code: "HS422",
			reason: "The date must be a real day",
		});
		expect(plan(state("alex"), { type: "addExpense", draft: draft({ entryDate: "0050-01-01" }) })).toMatchObject({
			ok: true,
		});
	});

	test("a decline note is sent as SQL stores it: spaces trimmed, blank is none", () => {
		const note = (n: string | null) => {
			const result = decline(n);
			return result.ok ? (result.mutations[0] as { note: string | null }).note : "refused";
		};
		expect(note("  Not yet  ")).toBe("Not yet");
		expect(note("   ")).toBeNull();
		expect(note(null)).toBeNull();
		// btrim strips spaces only.
		expect(note("\tcash\n")).toBe("\tcash\n");
	});

	test("createGroup refuses a blank display name", () => {
		expect(plan(null, { type: "createGroup", name: "Trip", displayName: "  " })).toEqual({
			ok: false,
			code: "HS422",
			reason: "A name must be 1 to 60 characters",
		});
	});
});

describe("planChange: bill validation", () => {
	const add = (d: Partial<ExpenseDraft>) => plan(state("alex"), { type: "addExpense", draft: draft(d) });

	test("each problem is HS422 with the server's reason", () => {
		expect(add({ description: " " })).toEqual({
			ok: false,
			code: "HS422",
			reason: "The description must be 1 to 120 characters",
		});
		expect(add({ items: [] })).toMatchObject({ code: "HS422" });
		expect(add({ items: [{ id: "i1", amountCents: 1000, paidBy: "alex", splitAmong: [] }] })).toEqual({
			ok: false,
			code: "HS422",
			reason: "Each item needs someone to split it",
		});
		expect(add({ items: [{ id: "i1", amountCents: 1000, paidBy: "alex", splitAmong: ["sam", "sam"] }] })).toEqual({
			ok: false,
			code: "HS422",
			reason: "Someone appears twice in an item's split",
		});
		expect(add({ items: [{ id: "i1", amountCents: 1000, paidBy: "alex", splitAmong: ["stranger"] }] })).toEqual({
			ok: false,
			code: "HS422",
			reason: "Everyone in a bill must be in this group",
		});
		expect(add({ entryDate: "2026-13-01" })).toEqual({
			ok: false,
			code: "HS422",
			reason: "The date must be a real day",
		});
	});

	test("people who left still count as in the group", () => {
		expect(add({ items: [{ id: "i1", amountCents: 1000, paidBy: "kim", splitAmong: ["kim", "alex"] }] })).toMatchObject(
			{
				ok: true,
			}
		);
	});
});

describe("planChange: categories and group notes", () => {
	const emoji = (n: number) => "\u{1F600}".repeat(n);

	test("createGroup carries the note as SQL stores it", () => {
		const create = (note: string | null | undefined) =>
			plan(null, { type: "createGroup", name: "Japan", displayName: "Alex", note });
		expect(create("  Tokyo and Kyoto, April ")).toMatchObject({
			ok: true,
			mutations: [{ type: "group.create", note: "Tokyo and Kyoto, April" }],
		});
		expect(create("   ")).toMatchObject({ mutations: [{ note: null }] });
		expect(create(undefined)).toMatchObject({ mutations: [{ note: null }] });
		expect(create(emoji(120))).toMatchObject({ ok: true });
		expect(create(` ${emoji(121)} `)).toEqual({
			ok: false,
			code: "HS422",
			reason: "A group note must be at most 120 characters",
		});
	});

	test("createGroup checks the note before the names, as the server does", () => {
		expect(plan(null, { type: "createGroup", name: "", displayName: "Alex", note: "x".repeat(121) })).toMatchObject({
			reason: "A group note must be at most 120 characters",
		});
	});

	test("describeGroup sets or clears the note", () => {
		expect(plan(state("alex"), { type: "describeGroup", note: " Osaka too " })).toEqual({
			ok: true,
			createdId: null,
			mutations: [{ id: "id-1", at: NOW, type: "group.describe", groupId: G, note: "Osaka too" }],
		});
		expect(plan(state("alex"), { type: "describeGroup", note: "  " })).toMatchObject({ mutations: [{ note: null }] });
		expect(plan(state("alex"), { type: "describeGroup", note: null })).toMatchObject({ mutations: [{ note: null }] });
		expect(plan(state("alex"), { type: "describeGroup", note: "x".repeat(121) })).toMatchObject({ code: "HS422" });
	});

	test("describeGroup is the owner's, and not in a completed group", () => {
		expect(plan(state("sam"), { type: "describeGroup", note: "Mine" })).toEqual({
			ok: false,
			code: "HS403",
			reason: "Only the group's owner can do this",
		});
		const completed = state("alex", { group: serverGroup({ id: G, completedAt: NOW, completedByMemberId: "alex" }) });
		expect(plan(completed, { type: "describeGroup", note: "Done" })).toEqual({
			ok: false,
			code: "HS403",
			reason: "This group is completed",
		});
	});

	test("bills carry their category through create, edit and resolve", () => {
		const food = draft({ category: "food" });
		expect(plan(state("alex"), { type: "addExpense", draft: food })).toMatchObject({
			mutations: [{ type: "entry.create", category: "food" }],
		});
		expect(plan(state("alex"), { type: "editExpense", entryId: "bill-alex", draft: food })).toMatchObject({
			mutations: [{ type: "entry.update", category: "food" }],
		});
		expect(
			plan(state("alex"), { type: "resolveConflict", conflictId: "c1", resolution: "merged", final: food })
		).toMatchObject({ mutations: [{ type: "conflict.resolve", entry: { category: "food" } }] });
		expect(plan(state("alex"), { type: "addExpense", draft: draft() })).toMatchObject({
			mutations: [{ category: null }],
		});
		const { category: _, ...noCategory } = draft();
		expect(plan(state("alex"), { type: "addExpense", draft: noCategory as ExpenseDraft })).toMatchObject({
			mutations: [{ category: null }],
		});
	});

	test("an unknown category is HS422, after the bill's own checks", () => {
		const bad = draft({ category: "bar" as never });
		expect(plan(state("alex"), { type: "addExpense", draft: bad })).toEqual({
			ok: false,
			code: "HS422",
			reason: "The category must be food, drinks, stay, travel, groceries or fun",
		});
		expect(plan(state("alex"), { type: "addExpense", draft: { ...bad, description: " " } })).toMatchObject({
			reason: "The description must be 1 to 120 characters",
		});
	});
});
