import { describe, expect, test } from "bun:test";

import { computeShares } from "@/lib/ledger";
import { applyMutation, mergePull } from "@/lib/sync/local";
import type { GroupChanges, Mutation } from "@/lib/sync/types";
import { createMemoryTables, serverEntry, serverGroup, serverMember } from "../../support/memory-tables";

const USER = "user-1";
const AT = "2026-11-02T09:30:00.000Z";

const change = (groupId: string, version: number, rows: Partial<GroupChanges> = {}): GroupChanges => ({
	groupId,
	version,
	groups: [],
	members: [],
	entries: [],
	conflicts: [],
	invites: [],
	...rows,
});

const create = (groupId: string): Mutation => ({
	id: `m-create-${groupId}`,
	at: AT,
	type: "group.create",
	groupId,
	memberId: `member-${groupId}`,
	name: "Japan 2027",
	displayName: "Alex",
});

const rename = (groupId: string, name: string): Mutation => ({
	id: `m-rename-${name}`,
	at: AT,
	type: "group.rename",
	groupId,
	name,
});

describe("mergePull", () => {
	test("stores server rows and moves the cursor", async () => {
		const { tables, groups, members, entries, cursors } = createMemoryTables();
		await mergePull(
			tables,
			{
				groupIds: ["g1"],
				changes: [
					change("g1", 4, {
						groups: [serverGroup({ id: "g1", rowVersion: 4 })],
						members: [serverMember({ id: "m1", groupId: "g1" })],
						entries: [serverEntry({ id: "e1", groupId: "g1" })],
					}),
				],
			},
			[],
			USER
		);

		expect(groups.get("g1")?.rowVersion).toBe(4);
		expect(members.has("m1")).toBe(true);
		expect(entries.has("e1")).toBe(true);
		expect(cursors.get("g1")).toEqual({ groupId: "g1", version: 4 });
	});

	test("an entry's shares are replaced, not merged", async () => {
		const { tables, entries } = createMemoryTables();
		await tables.entries.put([
			serverEntry({
				id: "e1",
				groupId: "g1",
				shares: computeShares([{ id: "i", amountCents: 900, paidBy: "a", splitAmong: ["a", "b", "c"] }]),
			}),
		]);
		const newShares = computeShares([{ id: "i", amountCents: 900, paidBy: "a", splitAmong: ["a", "b"] }]);
		await mergePull(
			tables,
			{
				groupIds: ["g1"],
				changes: [
					change("g1", 2, {
						groups: [serverGroup({ id: "g1" })],
						entries: [serverEntry({ id: "e1", groupId: "g1", shares: newShares, rowVersion: 2 })],
					}),
				],
			},
			[],
			USER
		);
		expect(entries.get("e1")?.shares).toEqual(newShares);
	});

	test("an unsent rename stays on top of an older server name", async () => {
		const { tables, groups } = createMemoryTables();
		await mergePull(
			tables,
			{ groupIds: ["g1"], changes: [change("g1", 2, { groups: [serverGroup({ id: "g1", name: "Old" })] })] },
			[rename("g1", "Renamed offline")],
			USER
		);
		expect(groups.get("g1")?.name).toBe("Renamed offline");
	});

	test("an unsent stale edit by someone else is not replayed; your own newer change is", async () => {
		const items = [{ id: "i", amountCents: 500, paidBy: "me", splitAmong: ["me"] }];
		const edit = (entryId: string, description: string): Mutation => ({
			id: `m-edit-${entryId}`,
			at: AT,
			type: "entry.update",
			groupId: "g1",
			entryId,
			baseVersion: 1,
			description,
			amountCents: 500,
			entryDate: "2026-11-02",
			notes: null,
			items,
			shares: computeShares(items),
		});
		const { tables, entries } = createMemoryTables();
		await mergePull(
			tables,
			{
				groupIds: ["g1"],
				changes: [
					change("g1", 5, {
						groups: [serverGroup({ id: "g1" })],
						members: [
							serverMember({ id: "me", groupId: "g1", userId: USER }),
							serverMember({ id: "jo", groupId: "g1", userId: "u-jo", role: "member" }),
						],
						entries: [
							serverEntry({
								id: "theirs",
								groupId: "g1",
								description: "Jo's edit",
								updatedByMemberId: "jo",
								rowVersion: 4,
							}),
							serverEntry({
								id: "mine",
								groupId: "g1",
								description: "My other device",
								updatedByMemberId: "me",
								rowVersion: 5,
							}),
						],
					}),
				],
			},
			[edit("theirs", "Stale"), edit("mine", "This device")],
			USER
		);
		expect(entries.get("theirs")?.description).toBe("Jo's edit");
		expect(entries.get("mine")?.description).toBe("This device");
	});

	test("a dropped group takes its entries, conflicts, invites and tokens with it", async () => {
		const local = createMemoryTables();
		const { tables } = local;
		await tables.groups.put([serverGroup({ id: "left" }), serverGroup({ id: "stays" })]);
		await tables.members.put([
			serverMember({ id: "m-left", groupId: "left" }),
			serverMember({ id: "m-stays", groupId: "stays" }),
		]);
		await tables.entries.put([serverEntry({ id: "e-left", groupId: "left" })]);
		await tables.conflicts.put([
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
		await tables.invites.put([
			{
				id: "i-left",
				groupId: "left",
				claimMemberId: null,
				createdBy: USER,
				createdAt: AT,
				expiresAt: AT,
				revokedAt: null,
				rowVersion: 1,
			},
		]);
		await tables.inviteTokens.put([{ inviteId: "i-left", groupId: "left", token: "t" }]);
		await tables.cursors.put([{ groupId: "left", version: 7 }]);
		const pending = [create("new-here")];
		await applyMutation(tables, pending[0], USER);

		await mergePull(tables, { groupIds: ["stays"], changes: [] }, pending, USER);

		expect([...local.groups.keys()].sort()).toEqual(["new-here", "stays"]);
		expect([...local.members.keys()].sort()).toEqual(["m-stays", "member-new-here"]);
		expect(local.entries.size).toBe(0);
		expect(local.conflicts.size).toBe(0);
		expect(local.invites.size).toBe(0);
		expect(local.inviteTokens.size).toBe(0);
		expect(local.cursors.size).toBe(0);
	});

	test("an invite's token survives the server's copy of the invite arriving", async () => {
		const { tables, inviteTokens, invites } = createMemoryTables();
		const pending: Mutation[] = [
			{
				id: "m-inv",
				at: AT,
				type: "invite.create",
				groupId: "g1",
				inviteId: "inv",
				token: "t".repeat(43),
				claimMemberId: null,
				expiresAt: AT,
			},
		];
		await mergePull(
			tables,
			{
				groupIds: ["g1"],
				changes: [
					change("g1", 3, {
						groups: [serverGroup({ id: "g1" })],
						invites: [
							{
								id: "inv",
								groupId: "g1",
								claimMemberId: null,
								createdBy: USER,
								createdAt: AT,
								expiresAt: AT,
								revokedAt: null,
								rowVersion: 3,
							},
						],
					}),
				],
			},
			pending,
			USER
		);
		expect(invites.get("inv")?.rowVersion).toBe(3);
		expect(inviteTokens.get("inv")?.token).toBe("t".repeat(43));
	});
});
