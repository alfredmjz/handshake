import { describe, expect, test } from "bun:test";

import { applyMutation, mergePull } from "@/lib/sync/local";
import type { Mutation } from "@/lib/sync/types";
import { createMemoryTables, serverGroup, serverMember } from "../../support/memory-tables";

const USER = "user-1";
const AT = "2026-11-02T09:30:00.000Z";

const create = (groupId: string, name = "Japan 2027"): Mutation => ({
	id: `m-create-${groupId}`,
	at: AT,
	type: "group.create",
	groupId,
	memberId: `member-${groupId}`,
	name,
	baseCurrency: "jpy",
	displayName: "Alex",
});

const rename = (groupId: string, name: string): Mutation => ({
	id: `m-rename-${groupId}-${name}`,
	at: AT,
	type: "group.rename",
	groupId,
	name,
});

describe("applyMutation", () => {
	test("creating a group adds it with you as owner, not yet synced", async () => {
		const { tables, groups, members } = createMemoryTables();
		await applyMutation(tables, create("g1", "  Japan 2027 "), USER);

		expect(groups.get("g1")).toEqual({
			id: "g1",
			name: "Japan 2027",
			baseCurrency: "JPY",
			createdBy: USER,
			createdAt: AT,
			deletedAt: null,
			rowVersion: 0,
		});
		expect(members.get("member-g1")).toMatchObject({ groupId: "g1", userId: USER, role: "owner", rowVersion: 0 });
	});

	test("a create never overwrites the server's copy", async () => {
		const { tables, groups } = createMemoryTables();
		await tables.putGroups([serverGroup({ id: "g1", name: "From server", rowVersion: 3 })]);
		await applyMutation(tables, create("g1"), USER);

		expect(groups.get("g1")?.name).toBe("From server");
		expect(groups.get("g1")?.rowVersion).toBe(3);
	});

	test("renaming a group this device doesn't have does nothing", async () => {
		const { tables, groups } = createMemoryTables();
		await applyMutation(tables, rename("missing", "New"), USER);
		expect(groups.size).toBe(0);
	});
});

describe("mergePull", () => {
	test("stores server rows and moves the cursor", async () => {
		const { tables, groups, members, cursors } = createMemoryTables();
		await mergePull(
			tables,
			{
				groupIds: ["g1"],
				changes: [
					{
						groupId: "g1",
						version: 4,
						groups: [serverGroup({ id: "g1", rowVersion: 4 })],
						members: [serverMember({ id: "m1", groupId: "g1" })],
					},
				],
			},
			[],
			USER
		);

		expect(groups.get("g1")?.rowVersion).toBe(4);
		expect(members.has("m1")).toBe(true);
		expect(cursors.get("g1")).toBe(4);
	});

	test("an unsent rename stays on top of an older server name", async () => {
		const { tables, groups } = createMemoryTables();
		const pending = [rename("g1", "Renamed offline")];
		await mergePull(
			tables,
			{
				groupIds: ["g1"],
				changes: [{ groupId: "g1", version: 2, groups: [serverGroup({ id: "g1", name: "Old" })], members: [] }],
			},
			pending,
			USER
		);

		expect(groups.get("g1")?.name).toBe("Renamed offline");
	});

	test("drops groups you no longer belong to, but keeps ones created here and not yet sent", async () => {
		const { tables, groups, members, cursors } = createMemoryTables();
		await tables.putGroups([serverGroup({ id: "left" }), serverGroup({ id: "stays" })]);
		await tables.putMembers([serverMember({ id: "m-left", groupId: "left" })]);
		await tables.setCursor("left", 7);
		const pending = [create("new-here")];
		await applyMutation(tables, pending[0], USER);

		await mergePull(tables, { groupIds: ["stays"], changes: [] }, pending, USER);

		expect([...groups.keys()].sort()).toEqual(["new-here", "stays"]);
		expect(members.has("m-left")).toBe(false);
		expect(cursors.has("left")).toBe(false);
	});
});
