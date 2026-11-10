import { describe, expect, test } from "bun:test";

import { applyMutation, mergePull } from "@/lib/sync/local";
import type { BillFields, GroupChanges, Mutation, MutationOf } from "@/lib/sync/types";
import { createMemoryTables, serverBill, serverGroup, serverMember } from "../../support/memory-tables";

const ME = "user-1";
const AT = "2026-11-02T09:30:00.000Z";

let seq = 0;
function change<T extends Mutation["type"]>(type: T, fields: Omit<MutationOf<T>, "id" | "at" | "type">) {
	return { id: `m${++seq}`, at: AT, type, ...fields } as MutationOf<T>;
}

function changes(groupId: string, version: number, rows: Partial<Omit<GroupChanges, "groupId" | "version">> = {}) {
	return { groupId, version, groups: [], members: [], entries: [], conflicts: [], invites: [], ...rows };
}

const alex = serverMember({ id: "alex", groupId: "g1", userId: ME, role: "owner" });
const sam = serverMember({ id: "sam", groupId: "g1", userId: "user-2", role: "member", displayName: "Sam" });

const edit: BillFields = {
	description: "Edited offline",
	amountCents: 1000,
	entryDate: "2026-11-02",
	notes: null,
	category: "stay",
	items: [{ id: "i1", amountCents: 1000, paidBy: "alex", splitAmong: ["alex"] }],
	shares: [{ memberId: "alex", paidCents: 1000, owedCents: 1000, owedTo: { alex: 1000 } }],
};

describe("mergePull", () => {
	test("server notes and categories land; an unsent note and category edit are replayed on top", async () => {
		const { tables, groups, entries } = createMemoryTables();
		const pending = [
			change("group.describe", { groupId: "g1", note: "Offline note" }),
			change("entry.update", { groupId: "g1", entryId: "e1", baseVersion: 2, ...edit }),
		];
		await mergePull(
			tables,
			{
				groupIds: ["g1"],
				changes: [
					changes("g1", 2, {
						groups: [serverGroup({ id: "g1", note: "Server note", rowVersion: 2 })],
						members: [alex],
						entries: [
							serverBill({ id: "e1", groupId: "g1", createdByMemberId: "alex", category: "food", rowVersion: 2 }),
						],
					}),
				],
			},
			pending,
			ME
		);
		expect(groups.map.get("g1")?.note).toBe("Offline note");
		expect(entries.map.get("e1")?.category).toBe("stay");

		await mergePull(
			tables,
			{
				groupIds: ["g1"],
				changes: [
					changes("g1", 3, {
						groups: [serverGroup({ id: "g1", note: "Server note", rowVersion: 3 })],
						entries: [
							serverBill({ id: "e1", groupId: "g1", createdByMemberId: "alex", category: "food", rowVersion: 3 }),
						],
					}),
				],
			},
			[],
			ME
		);
		expect(groups.map.get("g1")?.note).toBe("Server note");
		expect(entries.map.get("e1")?.category).toBe("food");
	});

	test("stores server rows of every kind and moves the cursor", async () => {
		const { tables, groups, members, entries, conflicts, invites, cursors } = createMemoryTables();
		await mergePull(
			tables,
			{
				groupIds: ["g1"],
				changes: [
					changes("g1", 4, {
						groups: [serverGroup({ id: "g1", rowVersion: 4 })],
						members: [alex],
						entries: [serverBill({ id: "e1", groupId: "g1", createdByMemberId: "alex" })],
						conflicts: [
							{
								id: "c1",
								groupId: "g1",
								entryId: "e1",
								baseVersion: 1,
								base: null,
								proposed: null,
								proposedByMemberId: "alex",
								createdAt: AT,
								resolvedAt: null,
								resolvedByMemberId: null,
								resolution: null,
								rowVersion: 3,
							},
						],
						invites: [
							{
								id: "inv1",
								groupId: "g1",
								claimMemberId: null,
								createdBy: ME,
								createdAt: AT,
								expiresAt: AT,
								revokedAt: null,
								rowVersion: 2,
							},
						],
					}),
				],
			},
			[],
			ME
		);

		expect(groups.map.get("g1")?.rowVersion).toBe(4);
		expect(members.map.has("alex")).toBe(true);
		expect(entries.map.has("e1")).toBe(true);
		expect(conflicts.map.has("c1")).toBe(true);
		expect(invites.map.has("inv1")).toBe(true);
		expect(cursors.map.get("g1")).toEqual({ groupId: "g1", version: 4 });
	});

	test("an entry's shares and items are replaced, not merged", async () => {
		const { tables, entries } = createMemoryTables();
		await tables.entries.put([
			serverBill({
				id: "e1",
				groupId: "g1",
				createdByMemberId: "alex",
				amountCents: 2000,
				items: [
					{ id: "i1", amountCents: 1000, paidBy: "alex", splitAmong: ["alex", "sam"] },
					{ id: "i2", amountCents: 1000, paidBy: "sam", splitAmong: ["sam"] },
				],
				shares: [
					{ memberId: "alex", paidCents: 1000, owedCents: 500, owedTo: { alex: 500 } },
					{ memberId: "sam", paidCents: 1000, owedCents: 1500, owedTo: { alex: 500, sam: 1000 } },
				],
			}),
		]);
		const fromServer = serverBill({ id: "e1", groupId: "g1", createdByMemberId: "alex", rowVersion: 2 });
		await mergePull(tables, { groupIds: ["g1"], changes: [changes("g1", 2, { entries: [fromServer] })] }, [], ME);

		expect(entries.map.get("e1")).toEqual(fromServer);
	});

	test("an unsent rename stays on top of an older server name", async () => {
		const { tables, groups } = createMemoryTables();
		await mergePull(
			tables,
			{ groupIds: ["g1"], changes: [changes("g1", 2, { groups: [serverGroup({ id: "g1", name: "Old" })] })] },
			[change("group.rename", { groupId: "g1", name: "Renamed offline" })],
			ME
		);
		expect(groups.map.get("g1")?.name).toBe("Renamed offline");
	});

	test("a dropped group takes its members, entries, conflicts, invites, tokens and cursor with it", async () => {
		const t = createMemoryTables();
		await t.tables.groups.put([serverGroup({ id: "left" }), serverGroup({ id: "stays" })]);
		await t.tables.members.put([
			serverMember({ id: "m-left", groupId: "left" }),
			serverMember({ id: "m-stays", groupId: "stays" }),
		]);
		await t.tables.entries.put([serverBill({ id: "e-left", groupId: "left", createdByMemberId: "m-left" })]);
		await t.tables.conflicts.put([
			{
				id: "c-left",
				groupId: "left",
				entryId: "e-left",
				baseVersion: 1,
				base: null,
				proposed: null,
				proposedByMemberId: "m-left",
				createdAt: AT,
				resolvedAt: null,
				resolvedByMemberId: null,
				resolution: null,
				rowVersion: 2,
			},
		]);
		await t.tables.invites.put([
			{
				id: "i-left",
				groupId: "left",
				claimMemberId: null,
				createdBy: ME,
				createdAt: AT,
				expiresAt: AT,
				revokedAt: null,
				rowVersion: 2,
			},
		]);
		await t.tables.inviteTokens.put([{ inviteId: "i-left", groupId: "left", token: "secret" }]);
		await t.tables.cursors.put([
			{ groupId: "left", version: 7 },
			{ groupId: "stays", version: 3 },
		]);

		await mergePull(t.tables, { groupIds: ["stays"], changes: [] }, [], ME);

		expect([...t.groups.map.keys()]).toEqual(["stays"]);
		expect([...t.members.map.keys()]).toEqual(["m-stays"]);
		expect(t.entries.map.size).toBe(0);
		expect(t.conflicts.map.size).toBe(0);
		expect(t.invites.map.size).toBe(0);
		expect(t.inviteTokens.map.size).toBe(0);
		expect([...t.cursors.map.keys()]).toEqual(["stays"]);
	});

	test("keeps groups created here and not yet sent", async () => {
		const { tables, groups, members } = createMemoryTables();
		const create = change("group.create", {
			groupId: "new-here",
			memberId: "me-new",
			name: "New",
			displayName: "Alex",
		});
		await applyMutation(tables, create, ME);

		await mergePull(tables, { groupIds: [], changes: [] }, [create], ME);

		expect([...groups.map.keys()]).toEqual(["new-here"]);
		expect(members.map.has("me-new")).toBe(true);
	});

	test("replays unsent changes in order on top of the server rows", async () => {
		const { tables, members, entries } = createMemoryTables();
		const pending: Mutation[] = [
			change("member.add", { groupId: "g1", memberId: "jo", displayName: "Jo" }),
			change("payment.record", {
				groupId: "g1",
				entryId: "p1",
				fromMemberId: "alex",
				toMemberId: "jo",
				amountCents: 500,
				entryDate: "2026-11-02",
				notes: null,
			}),
		];
		await mergePull(
			tables,
			{ groupIds: ["g1"], changes: [changes("g1", 3, { groups: [serverGroup({ id: "g1" })], members: [alex] })] },
			pending,
			ME
		);

		expect(members.map.get("jo")?.rowVersion).toBe(0);
		// Jo is name-only, so the replayed payment counts at once.
		expect(entries.map.get("p1")?.paymentStatus).toBe("confirmed");
	});

	describe("stale changes (architecture §4.2)", () => {
		async function samEditedIt() {
			const t = createMemoryTables();
			const bill = serverBill({
				id: "e1",
				groupId: "g1",
				createdByMemberId: "alex",
				rowVersion: 5,
				updatedByMemberId: "sam",
			});
			await mergePull(
				t.tables,
				{
					groupIds: ["g1"],
					changes: [changes("g1", 5, { groups: [serverGroup({ id: "g1" })], members: [alex, sam], entries: [bill] })],
				},
				[],
				ME
			);
			return { ...t, bill };
		}

		test("an unsent edit started from an older version that someone else changed is not replayed", async () => {
			const { tables, entries, bill } = await samEditedIt();
			const pending = [change("entry.update", { groupId: "g1", entryId: "e1", baseVersion: 2, ...edit })];
			await mergePull(tables, { groupIds: ["g1"], changes: [changes("g1", 5, { entries: [bill] })] }, pending, ME);
			expect(entries.map.get("e1")).toEqual(bill);
		});

		test("an unsent delete against someone else's newer edit is not replayed", async () => {
			const { tables, entries, bill } = await samEditedIt();
			const pending = [change("entry.delete", { groupId: "g1", entryId: "e1", baseVersion: 2 })];
			await mergePull(tables, { groupIds: ["g1"], changes: [] }, pending, ME);
			expect(entries.map.get("e1")).toEqual(bill);
		});

		test("an edit started from the current version is replayed", async () => {
			const { tables, entries } = await samEditedIt();
			const pending = [change("entry.update", { groupId: "g1", entryId: "e1", baseVersion: 5, ...edit })];
			await mergePull(tables, { groupIds: ["g1"], changes: [] }, pending, ME);
			expect(entries.map.get("e1")?.description).toBe("Edited offline");
		});

		test("your own newer change (another device) doesn't make yours stale", async () => {
			const t = createMemoryTables();
			const bill = serverBill({
				id: "e1",
				groupId: "g1",
				createdByMemberId: "alex",
				rowVersion: 5,
				updatedByMemberId: "alex",
			});
			const pending = [
				change("entry.update", { groupId: "g1", entryId: "e1", baseVersion: 2, ...edit }),
				change("entry.delete", { groupId: "g1", entryId: "e1", baseVersion: 2 }),
			];
			await mergePull(
				t.tables,
				{
					groupIds: ["g1"],
					changes: [changes("g1", 5, { groups: [serverGroup({ id: "g1" })], members: [alex, sam], entries: [bill] })],
				},
				pending,
				ME
			);
			expect(t.entries.map.get("e1")).toMatchObject({ description: "Edited offline", deletedAt: AT });
		});

		test("other unsent changes still replay around a skipped one", async () => {
			const { tables, entries, groups, bill } = await samEditedIt();
			const pending: Mutation[] = [
				change("entry.update", { groupId: "g1", entryId: "e1", baseVersion: 1, ...edit }),
				change("group.rename", { groupId: "g1", name: "Still renamed" }),
			];
			await mergePull(tables, { groupIds: ["g1"], changes: [] }, pending, ME);
			expect(entries.map.get("e1")).toEqual(bill);
			expect(groups.map.get("g1")?.name).toBe("Still renamed");
		});
	});
});

describe("full pulls after rejected changes", () => {
	// The device as a rejected push leaves it: synced once at version 3, then a local-only bill and rename.
	async function afterRejection() {
		const t = createMemoryTables();
		await mergePull(
			t.tables,
			{ groupIds: ["g1"], changes: [changes("g1", 3, { groups: [serverGroup({ id: "g1" })], members: [alex, sam] })] },
			[],
			ME
		);
		await applyMutation(t.tables, change("entry.create", { groupId: "g1", entryId: "rejected-bill", ...edit }), ME);
		await applyMutation(
			t.tables,
			change("member.rename", { groupId: "g1", memberId: "alex", displayName: "Renamed offline" }),
			ME
		);
		await t.tables.inviteTokens.put([{ inviteId: "rejected-invite", groupId: "g1", token: "t" }]);
		return t;
	}
	const fullPull = (rows: Partial<Omit<GroupChanges, "groupId" | "version">> = {}) => ({
		groupIds: ["g1"],
		changes: [changes("g1", 3, { groups: [serverGroup({ id: "g1" })], members: [alex, sam], ...rows })],
	});

	test("a full pull removes a local-only entry that no pending change recreates", async () => {
		const t = await afterRejection();
		await t.tables.cursors.delete(["g1"]);
		await mergePull(t.tables, fullPull(), [], ME);
		expect(t.entries.map.has("rejected-bill")).toBe(false);
		expect(t.inviteTokens.map.size).toBe(0);
	});

	test("a full pull restores the server's value over a local rename whose change is gone", async () => {
		const t = await afterRejection();
		await t.tables.cursors.put([{ groupId: "g1", version: 0 }]);
		await mergePull(t.tables, fullPull(), [], ME);
		expect(t.members.map.get("alex")?.displayName).toBe("Alex");
	});

	test("a full pull keeps rows that pending changes recreate, and drops server rows no longer sent", async () => {
		const t = await afterRejection();
		await t.tables.entries.put([serverBill({ id: "gone", groupId: "g1", createdByMemberId: "alex" })]);
		const bill = serverBill({ id: "kept", groupId: "g1", createdByMemberId: "sam" });
		const pending: Mutation[] = [
			change("entry.create", { groupId: "g1", entryId: "unsent-bill", ...edit }),
			change("invite.create", {
				groupId: "g1",
				inviteId: "unsent-invite",
				token: "u",
				claimMemberId: null,
				expiresAt: null,
			}),
		];
		await t.tables.cursors.delete(["g1"]);
		await mergePull(t.tables, fullPull({ entries: [bill] }), pending, ME);

		expect([...t.entries.map.keys()].sort()).toEqual(["kept", "unsent-bill"]);
		expect([...t.inviteTokens.map.keys()]).toEqual(["unsent-invite"]);
	});

	test("an incremental pull leaves rows it doesn't mention alone", async () => {
		const t = await afterRejection();
		await mergePull(t.tables, { groupIds: ["g1"], changes: [changes("g1", 4, { members: [sam] })] }, [], ME);
		expect(t.entries.map.has("rejected-bill")).toBe(true);
		expect(t.members.map.get("alex")?.displayName).toBe("Renamed offline");
	});

	test("a group created here and not yet sent survives a full pull of other groups", async () => {
		const t = await afterRejection();
		const create = change("group.create", {
			groupId: "new-here",
			memberId: "me-new",
			name: "New",
			displayName: "Alex",
		});
		await applyMutation(t.tables, create, ME);
		await t.tables.cursors.delete(["g1"]);
		await mergePull(t.tables, fullPull(), [create], ME);
		expect(t.groups.map.has("new-here")).toBe(true);
		expect(t.members.map.has("me-new")).toBe(true);
	});
});
