import "fake-indexeddb/auto";

import { describe, expect, test } from "bun:test";
import Dexie from "dexie";

import { LocalDb } from "@/lib/local-db";
import { dexieTables } from "@/lib/sync/dexie-store";
import { mergePull, type LocalTables } from "@/lib/sync/local";
import type { RowOf, TableName } from "@/lib/sync/tables";
import type { GroupChanges } from "@/lib/sync/types";
import { createMemoryTables, serverBill, serverGroup, serverMember } from "../../support/memory-tables";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const ME = "user-1";
const AT = "2026-11-01T12:00:00.000Z";

let dbCount = 0;
const adapters: [string, () => LocalTables][] = [
	["memory", () => createMemoryTables().tables],
	["dexie", () => dexieTables(new LocalDb(`tables-test-${++dbCount}`))],
];

type EveryTable = { [K in TableName]: RowOf<K>[] };

// One row of every replica table for the group; `tag` tells copies apart. Adding a table to the replica
// makes this a type error until the table has a row here.
function rowsOf(groupId: string, tag: string): EveryTable {
	const member = `${groupId}-${tag}-member`;
	const invite = `${groupId}-${tag}-invite`;
	return {
		groups: [serverGroup({ id: groupId, name: tag })],
		members: [serverMember({ id: member, groupId, userId: ME })],
		entries: [serverBill({ id: `${groupId}-${tag}-entry`, groupId, createdByMemberId: member })],
		conflicts: [
			{
				id: `${groupId}-${tag}-conflict`,
				groupId,
				entryId: `${groupId}-${tag}-entry`,
				baseVersion: 1,
				base: null,
				proposed: null,
				proposedByMemberId: member,
				createdAt: AT,
				resolvedAt: null,
				resolvedByMemberId: null,
				resolution: null,
				rowVersion: 1,
			},
		],
		invites: [
			{
				id: invite,
				groupId,
				claimMemberId: null,
				createdBy: ME,
				createdAt: AT,
				expiresAt: AT,
				revokedAt: null,
				rowVersion: 1,
			},
		],
		inviteTokens: [{ inviteId: invite, groupId, token: `${tag}-token` }],
		nudges: [
			{
				id: `${groupId}-${tag}-nudge`,
				groupId,
				fromMemberId: member,
				toMemberId: member,
				amountCents: 100,
				createdAt: AT,
				rowVersion: 1,
			},
		],
		guestCodes: [
			{ memberId: `${groupId}-${tag}-guest`, groupId, code: tag, createdAt: AT, deletedAt: null, rowVersion: 1 },
		],
		cursors: [{ groupId, version: 0 }],
	};
}

async function store(tables: LocalTables, rows: EveryTable) {
	for (const name of Object.keys(rows) as TableName[]) await tables[name].put(rows[name] as never);
}

async function read(tables: LocalTables, groupId: string) {
	const out: Partial<Record<TableName, unknown[]>> = {};
	for (const name of Object.keys(rowsOf(groupId, "")) as TableName[]) {
		out[name] = await tables[name].byGroup(groupId);
	}
	return out;
}

// Every replica table follows its description through mergePull, on both LocalTables adapters.
for (const [name, make] of adapters) {
	describe(`replica tables (${name})`, () => {
		test("a group the pull no longer lists leaves every table", async () => {
			const tables = make();
			await store(tables, rowsOf("g1", "old"));
			await store(tables, rowsOf("g2", "old"));

			await mergePull(tables, { groupIds: ["g2"], changes: [] }, [], ME);

			const empty = Object.fromEntries(Object.keys(rowsOf("g1", "")).map((table) => [table, []]));
			expect(await read(tables, "g1")).toEqual(empty);
			expect(await read(tables, "g2")).toEqual(rowsOf("g2", "old"));
		});

		test("a full pull replaces every pulled table and keeps only tokens of pulled invites", async () => {
			const tables = make();
			const old = rowsOf("g1", "old");
			const pulled = rowsOf("g1", "new");
			// A link this device made for an invite the pull still carries.
			const keptToken = pulled.inviteTokens[0];
			await store(tables, { ...old, inviteTokens: [...old.inviteTokens, keptToken] });
			const change: GroupChanges = {
				groupId: "g1",
				version: 5,
				groups: pulled.groups,
				members: pulled.members,
				entries: pulled.entries,
				conflicts: pulled.conflicts,
				invites: pulled.invites,
				nudges: pulled.nudges,
				guestCodes: pulled.guestCodes,
			};

			await mergePull(tables, { groupIds: ["g1"], changes: [change] }, [], ME);

			expect(await read(tables, "g1")).toEqual({
				...pulled,
				inviteTokens: [keptToken],
				cursors: [{ groupId: "g1", version: 5 }],
			});
		});

		test("a pull past version 0 adds to the tables without dropping rows", async () => {
			const tables = make();
			const old = rowsOf("g1", "old");
			await store(tables, { ...old, cursors: [{ groupId: "g1", version: 3 }] });
			const pulled = rowsOf("g1", "new");
			const change: GroupChanges = {
				groupId: "g1",
				version: 4,
				groups: [],
				members: pulled.members,
				entries: [],
				conflicts: [],
				invites: [],
				nudges: [],
				guestCodes: [],
			};

			await mergePull(tables, { groupIds: ["g1"], changes: [change] }, [], ME);

			const after = await read(tables, "g1");
			expect(after.members).toHaveLength(2);
			expect(after.members).toEqual(expect.arrayContaining([...old.members, ...pulled.members]));
			expect(after.entries).toEqual(old.entries);
			expect(after.inviteTokens).toEqual(old.inviteTokens);
			expect(after.cursors).toEqual([{ groupId: "g1", version: 4 }]);
		});
	});
}
