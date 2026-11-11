import "fake-indexeddb/auto";

import { describe, expect, test } from "bun:test";
import Dexie from "dexie";

import { LocalDb } from "@/lib/local-db";
import { createDexieSyncStore, dexieTables, readMovedAwayNotices } from "@/lib/sync/dexie-store";
import type { LocalTables } from "@/lib/sync/local";
import { createMemoryTables, serverBill, serverGroup, serverMember } from "../../support/memory-tables";

// Dexie may have looked for IndexedDB before fake-indexeddb installed it.
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

let dbCount = 0;
const adapters: [string, () => LocalTables][] = [
	["memory", () => createMemoryTables().tables],
	["dexie", () => dexieTables(new LocalDb(`rows-test-${++dbCount}`))],
];

// The same Rows contract for both LocalTables adapters.
for (const [name, make] of adapters) {
	describe(`Rows (${name})`, () => {
		test("put, get, byGroup and delete", async () => {
			const tables = make();
			await tables.members.put([
				serverMember({ id: "a", groupId: "g1" }),
				serverMember({ id: "b", groupId: "g1" }),
				serverMember({ id: "c", groupId: "g2" }),
			]);

			expect((await tables.members.get("a"))?.groupId).toBe("g1");
			expect(await tables.members.get("missing")).toBeUndefined();
			expect((await tables.members.byGroup("g1")).map((m) => m.id).sort()).toEqual(["a", "b"]);

			await tables.members.delete(["a", "missing"]);
			expect((await tables.members.byGroup("g1")).map((m) => m.id)).toEqual(["b"]);
		});

		test("put replaces a row whole", async () => {
			const tables = make();
			await tables.entries.put([serverBill({ id: "e1", groupId: "g1", createdByMemberId: "a", notes: "old" })]);
			const replacement = serverBill({ id: "e1", groupId: "g1", createdByMemberId: "b" });
			await tables.entries.put([replacement]);
			expect(await tables.entries.get("e1")).toEqual(replacement);
		});

		test("groups are their own group; cursors and tokens are keyed by group and invite", async () => {
			const tables = make();
			await tables.groups.put([serverGroup({ id: "g1" }), serverGroup({ id: "g2" })]);
			await tables.cursors.put([{ groupId: "g1", version: 3 }]);
			await tables.inviteTokens.put([{ inviteId: "i1", groupId: "g1", token: "t" }]);

			expect((await tables.groups.byGroup("g1")).map((g) => g.id)).toEqual(["g1"]);
			expect((await tables.groupIds()).sort()).toEqual(["g1", "g2"]);
			expect(await tables.cursors.get("g1")).toEqual({ groupId: "g1", version: 3 });
			expect(await tables.inviteTokens.byGroup("g1")).toEqual([{ inviteId: "i1", groupId: "g1", token: "t" }]);

			await tables.nudges.put([nudge, { ...nudge, id: "n2", groupId: "g2" }]);
			expect((await tables.nudges.byGroup("g1")).map((n) => n.id)).toEqual(["n1"]);

			await tables.inviteTokens.delete(["i1"]);
			await tables.cursors.delete(["g1"]);
			expect(await tables.inviteTokens.get("i1")).toBeUndefined();
			expect(await tables.cursors.get("g1")).toBeUndefined();
		});
	});
}

const nudge = {
	id: "n1",
	groupId: "g1",
	fromMemberId: "m1",
	toMemberId: "m2",
	amountCents: 300,
	createdAt: "2026-11-02T00:00:00.000Z",
	rowVersion: 4,
};

describe("createDexieSyncStore", () => {
	test("applies a pull in one transaction and reads cursors back", async () => {
		const db = new LocalDb(`rows-test-${++dbCount}`);
		const store = createDexieSyncStore(db, "user-1");
		await store.applyPull({
			groupIds: ["g1"],
			changes: [
				{
					groupId: "g1",
					version: 4,
					groups: [serverGroup({ id: "g1", rowVersion: 4 })],
					members: [serverMember({ id: "m1", groupId: "g1" })],
					entries: [serverBill({ id: "e1", groupId: "g1", createdByMemberId: "m1" })],
					conflicts: [],
					invites: [],
					nudges: [nudge],
					guestCodes: [],
				},
			],
		});

		expect(await store.cursors()).toEqual({ g1: 4 });
		expect(await db.nudges.where("toMemberId").equals("m2").toArray()).toEqual([nudge]);
		expect(await db.entries.where("[groupId+entryDate]").equals(["g1", "2026-11-01"]).count()).toBe(1);
	});
});

describe("LocalDb version 2", () => {
	test("upgrades version 1 rows and pulls everything again", async () => {
		const name = `rows-test-${++dbCount}`;
		const v1 = new Dexie(name);
		v1.version(1).stores({
			groups: "id",
			members: "id, groupId",
			outbox: "++seq, &id",
			cursors: "groupId",
			meta: "key",
		});
		await v1.table("groups").put({ id: "g1", name: "Trip", baseCurrency: "CAD", createdBy: "u1", rowVersion: 2 });
		await v1.table("members").put({ id: "m1", groupId: "g1", userId: "u1", role: "owner", rowVersion: 2 });
		await v1.table("cursors").put({ groupId: "g1", version: 2 });
		v1.close();

		const db = new LocalDb(name);
		expect(await db.groups.get("g1")).toEqual({
			id: "g1",
			name: "Trip",
			note: null,
			createdBy: "u1",
			completedAt: null,
			completedByMemberId: null,
			joinCode: null,
			rowVersion: 2,
		} as never);
		expect((await db.members.get("m1"))?.joinedAt).toBeNull();
		expect(await db.cursors.count()).toBe(0);
		expect(await db.entries.count()).toBe(0);
	});
});

describe("LocalDb version 3", () => {
	test("gives groups a note and entries a category, and pulls everything again", async () => {
		const name = `rows-test-${++dbCount}`;
		const v2 = new Dexie(name);
		v2.version(2).stores({
			groups: "id",
			members: "id, groupId",
			outbox: "++seq, &id",
			cursors: "groupId",
			meta: "key",
			entries: "id, groupId, [groupId+entryDate]",
			conflicts: "id, entryId, groupId",
			invites: "id, groupId",
			inviteTokens: "inviteId, groupId",
		});
		await v2.table("groups").put({ id: "g1", name: "Trip", rowVersion: 2 });
		await v2.table("entries").put({ id: "e1", groupId: "g1", entryDate: "2026-11-02", rowVersion: 2 });
		await v2.table("cursors").put({ groupId: "g1", version: 2 });
		v2.close();

		const db = new LocalDb(name);
		expect((await db.groups.get("g1"))?.note).toBeNull();
		expect((await db.entries.get("e1"))?.category).toBeNull();
		expect(await db.cursors.count()).toBe(0);
	});
});

describe("LocalDb version 4", () => {
	test("adds nudges and pulls everything again", async () => {
		const name = `rows-test-${++dbCount}`;
		const v3 = new Dexie(name);
		v3.version(3).stores({
			groups: "id",
			members: "id, groupId",
			outbox: "++seq, &id",
			cursors: "groupId",
			meta: "key",
			entries: "id, groupId, [groupId+entryDate]",
			conflicts: "id, entryId, groupId",
			invites: "id, groupId",
			inviteTokens: "inviteId, groupId",
		});
		await v3.table("groups").put({ id: "g1", name: "Trip", note: null, rowVersion: 2 });
		await v3.table("cursors").put({ groupId: "g1", version: 2 });
		v3.close();

		const db = new LocalDb(name);
		expect((await db.groups.get("g1"))?.name).toBe("Trip");
		expect(await db.nudges.count()).toBe(0);
		expect(await db.cursors.count()).toBe(0);
	});
});

describe("LocalDb version 5", () => {
	test("gives groups a joinCode, adds guestCodes and pulls everything again", async () => {
		const name = `rows-test-${++dbCount}`;
		const v4 = new Dexie(name);
		v4.version(4).stores({
			groups: "id",
			members: "id, groupId",
			outbox: "++seq, &id",
			cursors: "groupId",
			meta: "key",
			entries: "id, groupId, [groupId+entryDate]",
			conflicts: "id, entryId, groupId",
			invites: "id, groupId",
			inviteTokens: "inviteId, groupId",
			nudges: "id, groupId, toMemberId",
		});
		await v4.table("groups").put({ id: "g1", name: "Trip", note: null, rowVersion: 2 });
		await v4.table("cursors").put({ groupId: "g1", version: 2 });
		v4.close();

		const db = new LocalDb(name);
		expect((await db.groups.get("g1"))?.joinCode).toBeNull();
		expect(await db.guestCodes.count()).toBe(0);
		expect(await db.cursors.count()).toBe(0);
	});
});

describe("moved-away notices", () => {
	test("a pull that drops a group this guest lost to another device records a notice, once per group", async () => {
		const db = new LocalDb(`rows-test-${++dbCount}`);
		await db.groups.put(serverGroup({ id: "g1", name: "Banff" }));
		await db.members.put(
			serverMember({ id: "m1", groupId: "g1", userId: "user-1", role: "guest", displayName: "Kim" })
		);
		const store = createDexieSyncStore(db, "user-1");
		await store.applyPull({ groupIds: [], changes: [], movedAway: ["g1"] });
		await store.applyPull({ groupIds: [], changes: [], movedAway: ["g1"] });
		expect(await readMovedAwayNotices(db)).toEqual([{ groupId: "g1", groupName: "Banff", displayName: "Kim" }]);
		expect(await db.groups.count()).toBe(0);
	});
});
