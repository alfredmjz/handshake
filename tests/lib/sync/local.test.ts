import { describe, expect, test } from "bun:test";

import { applyMutation } from "@/lib/sync/local";
import type { BillFields, ConflictRow, EntryRow, Mutation, MutationOf } from "@/lib/sync/types";
import { createMemoryTables, serverBill, serverGroup, serverMember } from "../../support/memory-tables";

const ME = "user-1";
const SAM_USER = "user-2";
const AT = "2026-11-02T09:30:00.000Z";
const LATER = "2026-11-02T10:00:00.000Z";

let seq = 0;
function change<T extends Mutation["type"]>(type: T, fields: Omit<MutationOf<T>, "id" | "at" | "type">, at = AT) {
	return { id: `m${++seq}`, at, type, ...fields } as MutationOf<T>;
}

// g1: Alex (me, owner), Sam (member with a login), Jo (name-only).
async function seeded() {
	const t = createMemoryTables();
	await t.tables.groups.put([serverGroup({ id: "g1" })]);
	await t.tables.members.put([
		serverMember({ id: "alex", groupId: "g1", userId: ME, role: "owner" }),
		serverMember({ id: "sam", groupId: "g1", userId: SAM_USER, role: "member", displayName: "Sam" }),
		serverMember({ id: "jo", groupId: "g1", userId: null, role: "member", displayName: "Jo", joinedAt: null }),
	]);
	return t;
}

const dinner: BillFields = {
	description: "  Dinner ",
	amountCents: 3000,
	entryDate: "2026-11-02",
	notes: null,
	category: "food",
	items: [{ id: "i1", amountCents: 3000, paidBy: "alex", splitAmong: ["alex", "sam", "jo"] }],
	shares: [
		{ memberId: "alex", paidCents: 3000, owedCents: 1000, owedTo: { alex: 1000 } },
		{ memberId: "sam", paidCents: 0, owedCents: 1000, owedTo: { alex: 1000 } },
		{ memberId: "jo", paidCents: 0, owedCents: 1000, owedTo: { alex: 1000 } },
	],
};

function payment(overrides: Partial<EntryRow> & Pick<EntryRow, "id">): EntryRow {
	return serverBill({
		groupId: "g1",
		createdByMemberId: "alex",
		kind: "payment",
		description: "Payment",
		amountCents: 500,
		items: null,
		paymentStatus: "pending",
		payerConfirmedAt: AT,
		shares: [
			{ memberId: "sam", paidCents: 0, owedCents: 500, owedTo: { alex: 500 } },
			{ memberId: "alex", paidCents: 500, owedCents: 0, owedTo: {} },
		],
		...overrides,
	});
}

describe("groups", () => {
	test("creating a group adds it with you as owner, not yet synced", async () => {
		const { tables, groups, members } = createMemoryTables();
		await applyMutation(
			tables,
			change("group.create", { groupId: "g1", memberId: "me-1", name: "  Japan 2027 ", displayName: " Alex " }),
			ME
		);

		expect(groups.map.get("g1")).toEqual({
			id: "g1",
			name: "Japan 2027",
			note: null,
			createdBy: ME,
			createdAt: AT,
			deletedAt: null,
			completedAt: null,
			completedByMemberId: null,
			rowVersion: 0,
		});
		expect(members.map.get("me-1")).toEqual({
			id: "me-1",
			groupId: "g1",
			userId: ME,
			displayName: "Alex",
			role: "owner",
			joinedAt: AT,
			deletedAt: null,
			rowVersion: 0,
		});
	});

	test("a create never overwrites the server's copy", async () => {
		const { tables, groups, members } = createMemoryTables();
		await tables.groups.put([serverGroup({ id: "g1", name: "From server", rowVersion: 3 })]);
		await applyMutation(
			tables,
			change("group.create", { groupId: "g1", memberId: "x", name: "Mine", displayName: "A" }),
			ME
		);

		expect(groups.map.get("g1")).toMatchObject({ name: "From server", rowVersion: 3 });
		expect(members.map.size).toBe(0);
	});

	test("rename, delete, complete and reopen", async () => {
		const { tables, groups } = await seeded();
		await applyMutation(tables, change("group.rename", { groupId: "g1", name: " Banff " }), ME);
		expect(groups.map.get("g1")?.name).toBe("Banff");

		await applyMutation(tables, change("group.complete", { groupId: "g1" }), ME);
		expect(groups.map.get("g1")).toMatchObject({ completedAt: AT, completedByMemberId: "alex" });

		await applyMutation(tables, change("group.reopen", { groupId: "g1" }, LATER), ME);
		expect(groups.map.get("g1")).toMatchObject({ completedAt: null, completedByMemberId: null });

		await applyMutation(tables, change("group.delete", { groupId: "g1" }, LATER), ME);
		expect(groups.map.get("g1")?.deletedAt).toBe(LATER);
	});

	test("changes to a group this device doesn't have do nothing", async () => {
		const { tables, groups } = createMemoryTables();
		await applyMutation(tables, change("group.rename", { groupId: "missing", name: "New" }), ME);
		await applyMutation(tables, change("group.delete", { groupId: "missing" }), ME);
		await applyMutation(tables, change("group.describe", { groupId: "missing", note: "x" }), ME);
		expect(groups.map.size).toBe(0);
	});

	test("a group's note: set at create, changed and cleared by group.describe", async () => {
		const { tables, groups } = createMemoryTables();
		await applyMutation(
			tables,
			change("group.create", { groupId: "g1", memberId: "me-1", name: "Japan", displayName: "Alex", note: "Tokyo" }),
			ME
		);
		expect(groups.map.get("g1")?.note).toBe("Tokyo");
		await applyMutation(tables, change("group.describe", { groupId: "g1", note: " Osaka too " }), ME);
		expect(groups.map.get("g1")?.note).toBe("Osaka too");
		await applyMutation(tables, change("group.describe", { groupId: "g1", note: "  " }), ME);
		expect(groups.map.get("g1")?.note).toBeNull();
		await applyMutation(tables, change("group.describe", { groupId: "g1", note: "\tKyoto" }), ME);
		expect(groups.map.get("g1")?.note).toBe("\tKyoto");
		await applyMutation(tables, change("group.describe", { groupId: "g1", note: null }), ME);
		expect(groups.map.get("g1")?.note).toBeNull();
	});
});

describe("people", () => {
	test("adding someone by name makes a name-only member", async () => {
		const { tables, members } = await seeded();
		await applyMutation(tables, change("member.add", { groupId: "g1", memberId: "kim", displayName: " Kim " }), ME);
		expect(members.map.get("kim")).toEqual({
			id: "kim",
			groupId: "g1",
			userId: null,
			displayName: "Kim",
			role: "member",
			joinedAt: null,
			deletedAt: null,
			rowVersion: 0,
		});
	});

	test("renaming someone", async () => {
		const { tables, members } = await seeded();
		await applyMutation(tables, change("member.rename", { groupId: "g1", memberId: "jo", displayName: " Joanna" }), ME);
		expect(members.map.get("jo")?.displayName).toBe("Joanna");
	});

	test("removing someone keeps their row, soft-deleted, and undoes their pending payments", async () => {
		const { tables, members, entries } = await seeded();
		await tables.entries.put([payment({ id: "p1" }), payment({ id: "p2", paymentStatus: "confirmed" })]);
		await applyMutation(tables, change("member.remove", { groupId: "g1", memberId: "sam" }), ME);

		expect(members.map.get("sam")).toMatchObject({ deletedAt: AT, role: "member" });
		expect(entries.map.get("p1")).toMatchObject({ paymentStatus: "undone", closedAt: AT, updatedByMemberId: "sam" });
		expect(entries.map.get("p2")?.paymentStatus).toBe("confirmed");
	});

	test("the owner leaving hands the group to the full member who joined first", async () => {
		const { tables, members } = await seeded();
		await tables.members.put([
			serverMember({ id: "kim", groupId: "g1", userId: "user-3", role: "member", joinedAt: "2026-10-01T00:00:00Z" }),
		]);
		await applyMutation(tables, change("member.remove", { groupId: "g1", memberId: "alex" }), ME);

		expect(members.map.get("alex")).toMatchObject({ role: "member", deletedAt: AT });
		expect(members.map.get("kim")?.role).toBe("owner");
		expect(members.map.get("sam")?.role).toBe("member");
	});

	test("the last full member leaving deletes the group", async () => {
		const { tables, groups } = await seeded();
		await tables.members.put([serverMember({ id: "sam", groupId: "g1", userId: SAM_USER, role: "guest" })]);
		await applyMutation(tables, change("member.remove", { groupId: "g1", memberId: "alex" }), ME);
		expect(groups.map.get("g1")?.deletedAt).toBe(AT);
	});
});

describe("bills", () => {
	test("adding a bill stores it with its items and shares, added by your member row", async () => {
		const { tables, entries } = await seeded();
		await applyMutation(tables, change("entry.create", { groupId: "g1", entryId: "e1", ...dinner }), ME);

		expect(entries.map.get("e1")).toEqual({
			id: "e1",
			groupId: "g1",
			kind: "expense",
			description: "Dinner",
			amountCents: 3000,
			items: dinner.items,
			entryDate: "2026-11-02",
			notes: null,
			category: "food",
			paymentStatus: null,
			payerConfirmedAt: null,
			receiverConfirmedAt: null,
			confirmedAt: null,
			closedAt: null,
			closeNote: null,
			createdByMemberId: "alex",
			updatedByMemberId: "alex",
			createdAt: AT,
			updatedAt: AT,
			deletedAt: null,
			rowVersion: 0,
			shares: dinner.shares,
		});
	});

	test("a bill create never overwrites the server's copy", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([serverBill({ id: "e1", groupId: "g1", createdByMemberId: "sam", rowVersion: 5 })]);
		await applyMutation(tables, change("entry.create", { groupId: "g1", entryId: "e1", ...dinner }), ME);
		expect(entries.map.get("e1")).toMatchObject({ description: "Dinner", amountCents: 1000, rowVersion: 5 });
	});

	test("editing replaces the fields and shares, keeps the version, and restores a deleted bill", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([
			serverBill({ id: "e1", groupId: "g1", createdByMemberId: "sam", rowVersion: 4, deletedAt: AT }),
		]);
		await applyMutation(
			tables,
			change("entry.update", { groupId: "g1", entryId: "e1", baseVersion: 4, ...dinner }, LATER),
			ME
		);

		expect(entries.map.get("e1")).toMatchObject({
			description: "Dinner",
			amountCents: 3000,
			shares: dinner.shares,
			createdByMemberId: "sam",
			updatedByMemberId: "alex",
			updatedAt: LATER,
			deletedAt: null,
			rowVersion: 4,
		});
	});

	test("an edit carries the category; a bill without one has none", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([serverBill({ id: "e1", groupId: "g1", createdByMemberId: "alex", category: "stay" })]);
		await applyMutation(
			tables,
			change("entry.update", { groupId: "g1", entryId: "e1", baseVersion: 1, ...dinner }),
			ME
		);
		expect(entries.map.get("e1")?.category).toBe("food");
		await applyMutation(
			tables,
			change("entry.update", { groupId: "g1", entryId: "e1", baseVersion: 1, ...dinner, category: null }),
			ME
		);
		expect(entries.map.get("e1")?.category).toBeNull();
	});

	test("deleting soft-deletes; payments can't be edited or deleted as bills", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([
			serverBill({ id: "e1", groupId: "g1", createdByMemberId: "sam" }),
			payment({ id: "p1" }),
		]);
		await applyMutation(tables, change("entry.delete", { groupId: "g1", entryId: "e1", baseVersion: 1 }), ME);
		await applyMutation(tables, change("entry.delete", { groupId: "g1", entryId: "p1", baseVersion: 1 }), ME);
		await applyMutation(
			tables,
			change("entry.update", { groupId: "g1", entryId: "p1", baseVersion: 1, ...dinner }),
			ME
		);

		expect(entries.map.get("e1")).toMatchObject({ deletedAt: AT, updatedByMemberId: "alex" });
		expect(entries.map.get("p1")).toEqual(payment({ id: "p1" }));
	});

	test("changing a bill this device doesn't have does nothing", async () => {
		const { tables, entries } = await seeded();
		await applyMutation(
			tables,
			change("entry.update", { groupId: "g1", entryId: "nope", baseVersion: 0, ...dinner }),
			ME
		);
		await applyMutation(tables, change("entry.delete", { groupId: "g1", entryId: "nope", baseVersion: 0 }), ME);
		expect(entries.map.size).toBe(0);
	});
});

describe("conflicts", () => {
	const conflict: ConflictRow = {
		id: "c1",
		groupId: "g1",
		entryId: "e1",
		baseVersion: 1,
		base: null,
		proposed: null,
		proposedByMemberId: "sam",
		createdAt: AT,
		resolvedAt: null,
		resolvedByMemberId: null,
		resolution: null,
		rowVersion: 3,
	};

	test("resolving with a final version saves it and closes the conflict", async () => {
		const { tables, entries, conflicts } = await seeded();
		await tables.entries.put([serverBill({ id: "e1", groupId: "g1", createdByMemberId: "sam", rowVersion: 2 })]);
		await tables.conflicts.put([conflict]);
		await applyMutation(
			tables,
			change("conflict.resolve", {
				groupId: "g1",
				conflictId: "c1",
				entryId: "e1",
				resolution: "merged",
				entry: dinner,
			}),
			ME
		);

		expect(entries.map.get("e1")).toMatchObject({ amountCents: 3000, updatedByMemberId: "alex", deletedAt: null });
		expect(conflicts.map.get("c1")).toMatchObject({ resolvedAt: AT, resolvedByMemberId: "alex", resolution: "merged" });
	});

	test("resolving as deleted deletes the bill", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([serverBill({ id: "e1", groupId: "g1", createdByMemberId: "sam" })]);
		await tables.conflicts.put([conflict]);
		await applyMutation(
			tables,
			change("conflict.resolve", {
				groupId: "g1",
				conflictId: "c1",
				entryId: "e1",
				resolution: "took_proposed",
				entry: { deleted: true },
			}),
			ME
		);
		expect(entries.map.get("e1")?.deletedAt).toBe(AT);
	});

	test("a conflict already resolved is left alone", async () => {
		const { tables, entries, conflicts } = await seeded();
		const bill = serverBill({ id: "e1", groupId: "g1", createdByMemberId: "sam" });
		const resolved = { ...conflict, resolvedAt: AT, resolvedByMemberId: "sam", resolution: "kept_current" as const };
		await tables.entries.put([bill]);
		await tables.conflicts.put([resolved]);
		await applyMutation(
			tables,
			change("conflict.resolve", {
				groupId: "g1",
				conflictId: "c1",
				entryId: "e1",
				resolution: "merged",
				entry: dinner,
			}),
			ME
		);
		expect(entries.map.get("e1")).toEqual(bill);
		expect(conflicts.map.get("c1")).toEqual(resolved);
	});
});

describe("invites", () => {
	test("creating a link stores the invite and keeps its token on this device", async () => {
		const { tables, invites, inviteTokens } = await seeded();
		await applyMutation(
			tables,
			change("invite.create", {
				groupId: "g1",
				inviteId: "inv1",
				token: "t".repeat(43),
				claimMemberId: "jo",
				expiresAt: null,
			}),
			ME
		);

		expect(invites.map.get("inv1")).toEqual({
			id: "inv1",
			groupId: "g1",
			claimMemberId: "jo",
			createdBy: ME,
			createdAt: AT,
			expiresAt: "2026-11-16T09:30:00.000Z",
			revokedAt: null,
			rowVersion: 0,
		});
		expect(inviteTokens.map.get("inv1")).toEqual({ inviteId: "inv1", groupId: "g1", token: "t".repeat(43) });
	});

	test("a link lasts at most 14 days, whatever expiresAt asks", async () => {
		const { tables, invites } = await seeded();
		const base = { groupId: "g1", token: "t".repeat(43), claimMemberId: null };
		await applyMutation(
			tables,
			change("invite.create", { ...base, inviteId: "a", expiresAt: "2027-01-01T00:00:00Z" }),
			ME
		);
		await applyMutation(
			tables,
			change("invite.create", { ...base, inviteId: "b", expiresAt: "2026-11-05T00:00:00Z" }),
			ME
		);
		expect(invites.map.get("a")?.expiresAt).toBe("2026-11-16T09:30:00.000Z");
		expect(invites.map.get("b")?.expiresAt).toBe("2026-11-05T00:00:00.000Z");
	});

	test("revoking a link", async () => {
		const { tables, invites } = await seeded();
		await applyMutation(
			tables,
			change("invite.create", {
				groupId: "g1",
				inviteId: "inv1",
				token: "t".repeat(43),
				claimMemberId: null,
				expiresAt: null,
			}),
			ME
		);
		await applyMutation(tables, change("invite.revoke", { groupId: "g1", inviteId: "inv1" }, LATER), ME);
		expect(invites.map.get("inv1")?.revokedAt).toBe(LATER);
	});
});

describe("payments", () => {
	const record = (fromMemberId: string, toMemberId: string, extra: Partial<MutationOf<"payment.record">> = {}) =>
		change("payment.record", {
			groupId: "g1",
			entryId: "p1",
			fromMemberId,
			toMemberId,
			amountCents: 500,
			entryDate: "2026-11-02",
			notes: null,
			...extra,
		});

	test("paying someone with a login waits for them, with your side agreed", async () => {
		const { tables, entries } = await seeded();
		await applyMutation(tables, record("alex", "sam", { description: "  Train " }), ME);

		expect(entries.map.get("p1")).toEqual({
			id: "p1",
			groupId: "g1",
			kind: "payment",
			description: "Train",
			amountCents: 500,
			items: null,
			entryDate: "2026-11-02",
			notes: null,
			category: null,
			paymentStatus: "pending",
			payerConfirmedAt: AT,
			receiverConfirmedAt: null,
			confirmedAt: null,
			closedAt: null,
			closeNote: null,
			createdByMemberId: "alex",
			updatedByMemberId: "alex",
			createdAt: AT,
			updatedAt: AT,
			deletedAt: null,
			rowVersion: 0,
			shares: [
				{ memberId: "sam", paidCents: 0, owedCents: 500, owedTo: { alex: 500 } },
				{ memberId: "alex", paidCents: 500, owedCents: 0, owedTo: {} },
			],
		});
	});

	test("recording one you received sets the receiver's side; no description means Payment", async () => {
		const { tables, entries } = await seeded();
		await applyMutation(tables, record("sam", "alex", { description: " " }), ME);
		expect(entries.map.get("p1")).toMatchObject({
			description: "Payment",
			paymentStatus: "pending",
			payerConfirmedAt: null,
			receiverConfirmedAt: AT,
		});
	});

	test("with someone who can't answer, it counts at once", async () => {
		const { tables, entries, members } = await seeded();
		await applyMutation(tables, record("alex", "jo"), ME);
		expect(entries.map.get("p1")).toMatchObject({ paymentStatus: "confirmed", payerConfirmedAt: AT, confirmedAt: AT });

		// Someone who left can't answer either.
		await tables.members.put([{ ...members.map.get("sam")!, deletedAt: AT }]);
		await applyMutation(tables, { ...record("sam", "alex"), entryId: "p2" }, ME);
		expect(entries.map.get("p2")).toMatchObject({
			paymentStatus: "confirmed",
			receiverConfirmedAt: AT,
			confirmedAt: AT,
		});
	});

	test("between two name-only people, only confirmedAt is set", async () => {
		const { tables, entries } = await seeded();
		await tables.members.put([serverMember({ id: "kim", groupId: "g1", userId: null, role: "member" })]);
		await applyMutation(tables, record("jo", "kim"), ME);
		expect(entries.map.get("p1")).toMatchObject({
			paymentStatus: "confirmed",
			payerConfirmedAt: null,
			receiverConfirmedAt: null,
			confirmedAt: AT,
			createdByMemberId: "alex",
		});
	});

	test("the other side confirms", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([payment({ id: "p1" })]);
		await applyMutation(tables, change("payment.confirm", { groupId: "g1", entryId: "p1" }, LATER), SAM_USER);
		expect(entries.map.get("p1")).toMatchObject({
			paymentStatus: "confirmed",
			payerConfirmedAt: AT,
			receiverConfirmedAt: LATER,
			confirmedAt: LATER,
			updatedByMemberId: "sam",
		});
	});

	test("your own side can't confirm", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([payment({ id: "p1" })]);
		await applyMutation(tables, change("payment.confirm", { groupId: "g1", entryId: "p1" }), ME);
		expect(entries.map.get("p1")).toEqual(payment({ id: "p1" }));
	});

	test("the other side declines with a note", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([payment({ id: "p1" })]);
		await applyMutation(
			tables,
			change("payment.decline", { groupId: "g1", entryId: "p1", note: "Not yet" }, LATER),
			SAM_USER
		);
		expect(entries.map.get("p1")).toMatchObject({ paymentStatus: "declined", closedAt: LATER, closeNote: "Not yet" });
	});

	test("the decline note is stored as it arrives (the planner already stored it as SQL does)", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([payment({ id: "p1" }), payment({ id: "p2" })]);
		await applyMutation(tables, change("payment.decline", { groupId: "g1", entryId: "p1", note: "\tcash" }), SAM_USER);
		await applyMutation(tables, change("payment.decline", { groupId: "g1", entryId: "p2", note: null }), SAM_USER);
		expect(entries.map.get("p1")?.closeNote).toBe("\tcash");
		expect(entries.map.get("p2")?.closeNote).toBeNull();
	});

	test("only whoever recorded it can undo it, while it waits", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([payment({ id: "p1" })]);
		await applyMutation(tables, change("payment.undo", { groupId: "g1", entryId: "p1" }), SAM_USER);
		expect(entries.map.get("p1")?.paymentStatus).toBe("pending");

		await applyMutation(tables, change("payment.undo", { groupId: "g1", entryId: "p1" }, LATER), ME);
		expect(entries.map.get("p1")).toMatchObject({ paymentStatus: "undone", closedAt: LATER });
	});

	test("answering a payment that isn't pending does nothing", async () => {
		const { tables, entries } = await seeded();
		const confirmed = payment({ id: "p1", paymentStatus: "confirmed", confirmedAt: AT });
		await tables.entries.put([confirmed]);
		await applyMutation(tables, change("payment.decline", { groupId: "g1", entryId: "p1", note: null }), SAM_USER);
		expect(entries.map.get("p1")).toEqual(confirmed);
	});
});
