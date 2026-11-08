import { describe, expect, test } from "bun:test";

import { computeShares } from "@/lib/ledger";
import { applyMutation } from "@/lib/sync/local";
import type { BillFields, Mutation } from "@/lib/sync/types";
import { createMemoryTables, serverEntry, serverGroup, serverMember } from "../../support/memory-tables";

const USER = "user-1";
const AT = "2026-11-02T09:30:00.000Z";

type Body = Mutation extends infer M ? (M extends Mutation ? Omit<M, "id" | "at"> : never) : never;
let seq = 0;
const m = (body: Body): Mutation => ({ id: `m${++seq}`, at: AT, ...body }) as Mutation;

const items = [{ id: "i1", amountCents: 1000, paidBy: "me", splitAmong: ["me", "jo", "sam"] }];
const bill: BillFields = {
	description: " Dinner ",
	amountCents: 1000,
	entryDate: "2026-11-02",
	notes: null,
	items,
	shares: computeShares(items),
};

// A synced group "g" where this user is "me" (owner), with Jo (logged in) and Sam (name-only).
async function seeded() {
	const local = createMemoryTables();
	await local.tables.groups.put([serverGroup({ id: "g" })]);
	await local.tables.members.put([
		serverMember({ id: "me", groupId: "g", userId: USER, role: "owner", joinedAt: "2026-11-01T00:00:00.000Z" }),
		serverMember({
			id: "jo",
			groupId: "g",
			userId: "user-jo",
			role: "member",
			displayName: "Jo",
			joinedAt: "2026-11-01T01:00:00.000Z",
		}),
		serverMember({ id: "sam", groupId: "g", userId: null, role: "member", displayName: "Sam", joinedAt: null }),
	]);
	return local;
}

describe("applyMutation: groups", () => {
	test("creating a group adds it with you as owner, not yet synced", async () => {
		const { tables, groups, members } = createMemoryTables();
		await applyMutation(
			tables,
			m({ type: "group.create", groupId: "g1", memberId: "me", name: "  Japan 2027 ", displayName: "Alex" }),
			USER
		);

		expect(groups.get("g1")).toEqual({
			id: "g1",
			name: "Japan 2027",
			createdBy: USER,
			createdAt: AT,
			deletedAt: null,
			completedAt: null,
			completedByMemberId: null,
			rowVersion: 0,
		});
		expect(members.get("me")).toEqual({
			id: "me",
			groupId: "g1",
			userId: USER,
			displayName: "Alex",
			role: "owner",
			joinedAt: AT,
			deletedAt: null,
			rowVersion: 0,
		});
	});

	test("a create never overwrites the server's copy", async () => {
		const { tables, groups } = createMemoryTables();
		await tables.groups.put([serverGroup({ id: "g1", name: "From server", rowVersion: 3 })]);
		await applyMutation(
			tables,
			m({ type: "group.create", groupId: "g1", memberId: "me", name: "Mine", displayName: "A" }),
			USER
		);
		expect(groups.get("g1")).toMatchObject({ name: "From server", rowVersion: 3 });
	});

	test("rename, delete, complete and reopen", async () => {
		const { tables, groups } = await seeded();
		await applyMutation(tables, m({ type: "group.rename", groupId: "g", name: " Banff " }), USER);
		expect(groups.get("g")?.name).toBe("Banff");

		await applyMutation(tables, m({ type: "group.complete", groupId: "g" }), USER);
		expect(groups.get("g")).toMatchObject({ completedAt: AT, completedByMemberId: "me" });
		await applyMutation(tables, m({ type: "group.reopen", groupId: "g" }), USER);
		expect(groups.get("g")).toMatchObject({ completedAt: null, completedByMemberId: null });

		await applyMutation(tables, m({ type: "group.delete", groupId: "g" }), USER);
		expect(groups.get("g")?.deletedAt).toBe(AT);
	});

	test("changing a group this device doesn't have does nothing", async () => {
		const { tables, groups } = createMemoryTables();
		await applyMutation(tables, m({ type: "group.rename", groupId: "missing", name: "New" }), USER);
		expect(groups.size).toBe(0);
	});
});

describe("applyMutation: people", () => {
	test("adding someone by name makes a name-only person", async () => {
		const { tables, members } = await seeded();
		await applyMutation(tables, m({ type: "member.add", groupId: "g", memberId: "kim", displayName: " Kim " }), USER);
		expect(members.get("kim")).toEqual({
			id: "kim",
			groupId: "g",
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
		await applyMutation(
			tables,
			m({ type: "member.rename", groupId: "g", memberId: "sam", displayName: "Samantha" }),
			USER
		);
		expect(members.get("sam")?.displayName).toBe("Samantha");
	});

	test("removing someone keeps the row and undoes their pending payments", async () => {
		const { tables, members, entries } = await seeded();
		await tables.entries.put([
			serverEntry({
				id: "p",
				groupId: "g",
				kind: "payment",
				items: null,
				paymentStatus: "pending",
				shares: computeShares([{ id: "p", amountCents: 500, paidBy: "jo", splitAmong: ["me"] }]),
			}),
		]);
		await applyMutation(tables, m({ type: "member.remove", groupId: "g", memberId: "jo" }), USER);
		expect(members.get("jo")?.deletedAt).toBe(AT);
		expect(entries.get("p")).toMatchObject({ paymentStatus: "undone", closedAt: AT });
	});

	test("an owner who leaves hands the group to the full member who joined first", async () => {
		const { tables, members, groups } = await seeded();
		await applyMutation(tables, m({ type: "member.remove", groupId: "g", memberId: "me" }), USER);
		expect(members.get("me")).toMatchObject({ deletedAt: AT, role: "member" });
		expect(members.get("jo")?.role).toBe("owner");
		expect(groups.get("g")?.deletedAt).toBeNull();
	});

	test("the last full member leaving deletes the group", async () => {
		const { tables, groups } = await seeded();
		await applyMutation(tables, m({ type: "member.remove", groupId: "g", memberId: "jo" }), USER);
		await applyMutation(tables, m({ type: "member.remove", groupId: "g", memberId: "me" }), USER);
		expect(groups.get("g")?.deletedAt).toBe(AT);
	});
});

describe("applyMutation: bills", () => {
	test("creating a bill stores it with its items and shares, added by you", async () => {
		const { tables, entries } = await seeded();
		await applyMutation(tables, m({ type: "entry.create", groupId: "g", entryId: "e", ...bill }), USER);
		expect(entries.get("e")).toMatchObject({
			kind: "expense",
			description: "Dinner",
			amountCents: 1000,
			items,
			shares: computeShares(items),
			paymentStatus: null,
			createdByMemberId: "me",
			updatedByMemberId: "me",
			rowVersion: 0,
		});
	});

	test("updating replaces the bill whole, and restores a deleted one", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([
			serverEntry({ id: "e", groupId: "g", updatedByMemberId: "jo", deletedAt: "2026-11-01T00:00:00Z" }),
		]);
		await applyMutation(tables, m({ type: "entry.update", groupId: "g", entryId: "e", baseVersion: 1, ...bill }), USER);
		expect(entries.get("e")).toMatchObject({
			description: "Dinner",
			shares: computeShares(items),
			updatedByMemberId: "me",
			deletedAt: null,
		});
	});

	test("deleting is soft", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([serverEntry({ id: "e", groupId: "g" })]);
		await applyMutation(tables, m({ type: "entry.delete", groupId: "g", entryId: "e", baseVersion: 1 }), USER);
		expect(entries.get("e")).toMatchObject({ deletedAt: AT, updatedByMemberId: "me" });
	});

	test("resolving a conflict applies the final version and closes it", async () => {
		const { tables, entries, conflicts } = await seeded();
		await tables.entries.put([serverEntry({ id: "e", groupId: "g" })]);
		await tables.conflicts.put([
			{
				id: "c",
				groupId: "g",
				entryId: "e",
				baseVersion: 1,
				base: null,
				proposed: null,
				proposedByMemberId: "jo",
				createdAt: AT,
				resolvedAt: null,
				resolvedByMemberId: null,
				resolution: null,
				rowVersion: 2,
			},
		]);
		await applyMutation(
			tables,
			m({
				type: "conflict.resolve",
				groupId: "g",
				conflictId: "c",
				entryId: "e",
				resolution: "took_proposed",
				entry: { deleted: true },
			}),
			USER
		);
		expect(conflicts.get("c")).toMatchObject({ resolvedAt: AT, resolvedByMemberId: "me", resolution: "took_proposed" });
		expect(entries.get("e")?.deletedAt).toBe(AT);
	});
});

describe("applyMutation: invites", () => {
	test("creating an invite keeps its token on this device", async () => {
		const { tables, invites, inviteTokens } = await seeded();
		const token = "a".repeat(43);
		await applyMutation(
			tables,
			m({
				type: "invite.create",
				groupId: "g",
				inviteId: "inv",
				token,
				claimMemberId: "sam",
				expiresAt: "2026-11-16T09:30:00.000Z",
			}),
			USER
		);
		expect(invites.get("inv")).toMatchObject({ claimMemberId: "sam", createdBy: USER, revokedAt: null, rowVersion: 0 });
		expect(inviteTokens.get("inv")).toEqual({ inviteId: "inv", groupId: "g", token });

		await applyMutation(tables, m({ type: "invite.revoke", groupId: "g", inviteId: "inv" }), USER);
		expect(invites.get("inv")?.revokedAt).toBe(AT);
	});
});

describe("applyMutation: payments", () => {
	const record = (from: string, to: string) =>
		m({
			type: "payment.record",
			groupId: "g",
			entryId: "p",
			fromMemberId: from,
			toMemberId: to,
			amountCents: 333,
			entryDate: "2026-11-02",
			notes: null,
		});

	test("a payment to someone who can answer waits for them", async () => {
		const { tables, entries } = await seeded();
		await applyMutation(tables, record("me", "jo"), USER);
		expect(entries.get("p")).toMatchObject({
			kind: "payment",
			description: "Payment",
			items: null,
			paymentStatus: "pending",
			payerConfirmedAt: AT,
			receiverConfirmedAt: null,
			confirmedAt: null,
			createdByMemberId: "me",
			shares: computeShares([{ id: "p", amountCents: 333, paidBy: "me", splitAmong: ["jo"] }]),
		});
	});

	test("a payment from a name-only person counts at once", async () => {
		const { tables, entries } = await seeded();
		await applyMutation(tables, record("sam", "me"), USER);
		expect(entries.get("p")).toMatchObject({ paymentStatus: "confirmed", receiverConfirmedAt: AT, confirmedAt: AT });
	});

	test("confirming, declining and undoing", async () => {
		const { tables, entries } = await seeded();
		const pending = serverEntry({
			id: "p",
			groupId: "g",
			kind: "payment",
			items: null,
			paymentStatus: "pending",
			payerConfirmedAt: "2026-11-01T00:00:00Z",
			createdByMemberId: "jo",
			shares: computeShares([{ id: "p", amountCents: 333, paidBy: "jo", splitAmong: ["me"] }]),
		});

		await tables.entries.put([pending]);
		await applyMutation(tables, m({ type: "payment.confirm", groupId: "g", entryId: "p" }), USER);
		expect(entries.get("p")).toMatchObject({ paymentStatus: "confirmed", receiverConfirmedAt: AT, confirmedAt: AT });

		await tables.entries.put([pending]);
		await applyMutation(tables, m({ type: "payment.decline", groupId: "g", entryId: "p", note: "  Not yet " }), USER);
		expect(entries.get("p")).toMatchObject({ paymentStatus: "declined", closedAt: AT, closeNote: "Not yet" });

		await tables.entries.put([pending]);
		await applyMutation(tables, m({ type: "payment.undo", groupId: "g", entryId: "p" }), USER);
		expect(entries.get("p")).toMatchObject({ paymentStatus: "undone", closedAt: AT });
	});

	test("answering a payment that isn't pending any more does nothing", async () => {
		const { tables, entries } = await seeded();
		await tables.entries.put([
			serverEntry({ id: "p", groupId: "g", kind: "payment", items: null, paymentStatus: "declined" }),
		]);
		await applyMutation(tables, m({ type: "payment.confirm", groupId: "g", entryId: "p" }), USER);
		expect(entries.get("p")?.paymentStatus).toBe("declined");
	});
});
