import { describe, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { LocalDb } from "@/lib/local-db";
import { dexieTables } from "@/lib/sync/dexie-store";
import type { LocalTables } from "@/lib/sync/local";
import { createMemoryTables, serverEntry, serverGroup, serverMember } from "../../support/memory-tables";

// Both LocalTables adapters honour the same Rows<T> interface: the memory one the other tests use, and
// the Dexie one the app uses (on fake-indexeddb).
function describeLocalTables(name: string, make: () => Promise<LocalTables>) {
	describe(`LocalTables: ${name}`, () => {
		test("get, byGroup, put and delete", async () => {
			const tables = await make();
			await tables.groups.put([serverGroup({ id: "g1" }), serverGroup({ id: "g2" })]);
			await tables.members.put([
				serverMember({ id: "a", groupId: "g1" }),
				serverMember({ id: "b", groupId: "g1" }),
				serverMember({ id: "c", groupId: "g2" }),
			]);
			await tables.entries.put([serverEntry({ id: "e", groupId: "g1" })]);
			await tables.inviteTokens.put([{ inviteId: "i", groupId: "g2", token: "t" }]);
			await tables.cursors.put([{ groupId: "g1", version: 3 }]);

			expect((await tables.groupIds()).sort()).toEqual(["g1", "g2"]);
			expect(await tables.groups.get("g1")).toEqual(serverGroup({ id: "g1" }));
			expect(await tables.groups.byGroup("g2")).toEqual([serverGroup({ id: "g2" })]);
			expect((await tables.members.byGroup("g1")).map((m) => m.id).sort()).toEqual(["a", "b"]);
			expect(await tables.entries.get("e")).toEqual(serverEntry({ id: "e", groupId: "g1" }));
			expect(await tables.inviteTokens.get("i")).toEqual({ inviteId: "i", groupId: "g2", token: "t" });
			expect(await tables.cursors.byGroup("g1")).toEqual([{ groupId: "g1", version: 3 }]);
			expect(await tables.members.get("missing")).toBeUndefined();

			await tables.members.put([serverMember({ id: "a", groupId: "g1", displayName: "Renamed" })]);
			expect((await tables.members.get("a"))?.displayName).toBe("Renamed");

			await tables.members.delete(["a", "missing"]);
			await tables.cursors.delete(["g1"]);
			expect((await tables.members.byGroup("g1")).map((m) => m.id)).toEqual(["b"]);
			expect(await tables.cursors.get("g1")).toBeUndefined();

			await tables.members.put([]);
			await tables.members.delete([]);
		});

		test("rows read back are copies", async () => {
			const tables = await make();
			await tables.groups.put([serverGroup({ id: "g1" })]);
			const read = await tables.groups.get("g1");
			read!.name = "Changed outside";
			expect((await tables.groups.get("g1"))?.name).toBe("Trip");
		});
	});
}

describeLocalTables("memory", async () => createMemoryTables().tables);
describeLocalTables("Dexie", async () => {
	const db = new LocalDb("rows-contract", { indexedDB: new IDBFactory(), IDBKeyRange });
	await db.open();
	return dexieTables(db);
});
