import { describe, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { createCommitter, type Intent } from "@/lib/changes";
import { LocalDb } from "@/lib/local-db";
import { serverGroup, serverMember } from "../support/memory-tables";

const USER = "u-me";
const NOW = new Date("2026-11-04T18:00:00.000Z");

async function setup(seed = true) {
	const indexedDB = new IDBFactory();
	const db = new LocalDb("commit-test", { indexedDB, IDBKeyRange });
	await db.open();
	if (seed) {
		await db.groups.put(serverGroup({ id: "g" }));
		await db.members.bulkPut([
			serverMember({ id: "me", groupId: "g", userId: USER, displayName: "Alex", role: "owner" }),
			serverMember({ id: "sam", groupId: "g", userId: "u-sam", displayName: "Sam", role: "member" }),
		]);
	}
	let n = 0;
	const syncs: number[] = [];
	const commit = createCommitter({
		db,
		userId: USER,
		isAnonymous: false,
		requestSync: () => syncs.push(1),
		newId: () => `id${++n}`,
		randomToken: () => "T".repeat(43),
		now: () => NOW,
	});
	return { db, commit, syncs, indexedDB };
}

const recordPayment: Intent = {
	groupId: "g",
	type: "recordPayment",
	from: "me",
	to: "sam",
	amountCents: 1000,
	entryDate: "2026-11-04",
	notes: null,
};

describe("commit", () => {
	test("two taps on Record payment queue one payment", async () => {
		const { db, commit } = await setup();
		const [first, second] = await Promise.all([commit(recordPayment), commit(recordPayment)]);

		expect([first.ok, second.ok].sort()).toEqual([false, true]);
		expect([first, second].find((plan) => !plan.ok)).toMatchObject({ code: "HS409" });
		expect(await db.outbox.count()).toBe(1);
		expect(await db.entries.where("groupId").equals("g").count()).toBe(1);
	});

	test("a failing write rolls back both the rows and the outbox", async () => {
		const { db, commit, syncs } = await setup(false);
		db.outbox.hook("creating", () => {
			throw new Error("The disk is full");
		});

		await expect(commit({ type: "createGroup", name: "Banff", displayName: "Alex" })).rejects.toThrow(
			"The disk is full"
		);
		expect(await db.groups.count()).toBe(0);
		expect(await db.members.count()).toBe(0);
		expect(await db.outbox.count()).toBe(0);
		expect(syncs).toEqual([]);
	});

	test("the outbox holds a commit's mutations in plan order, after earlier commits", async () => {
		const { db, commit } = await setup();
		const rename = await commit({ groupId: "g", type: "renameGroup", name: "Banff" });
		const add = await commit({ groupId: "g", type: "addPerson", displayName: "Kim" });
		if (!rename.ok || !add.ok) throw new Error("expected both to plan");

		const queued = (await db.outbox.orderBy("seq").toArray()).map((entry) => entry.mutation);
		expect(queued).toEqual([...rename.mutations, ...add.mutations]);
		expect((await db.groups.get("g"))?.name).toBe("Banff");
	});

	test("requestSync runs only when something was queued", async () => {
		const { commit, syncs } = await setup();
		await commit({ groupId: "g", type: "reopenGroup" }); // open already: nothing to do
		await commit({ groupId: "g", type: "renameGroup", name: "  " }); // refused
		expect(syncs).toEqual([]);
		await commit({ groupId: "g", type: "renameGroup", name: "Banff" });
		expect(syncs).toEqual([1]);
	});

	test("createdId names the new row", async () => {
		const { db, commit } = await setup();

		const group = await commit({ type: "createGroup", name: "Japan 2027", displayName: "Alex" });
		expect(group.ok && (await db.groups.get(group.createdId!))?.name).toBe("Japan 2027");

		const expense = await commit({
			groupId: "g",
			type: "addExpense",
			draft: {
				description: "Dinner",
				entryDate: "2026-11-04",
				notes: null,
				items: [{ id: "i1", amountCents: 1000, paidBy: "me", splitAmong: ["me", "sam"] }],
			},
		});
		expect(expense.ok && (await db.entries.get(expense.createdId!))?.amountCents).toBe(1000);

		const invite = await commit({ groupId: "g", type: "createInvite", claimMemberId: null });
		expect(invite.ok && (await db.invites.get(invite.createdId!))?.groupId).toBe("g");
		expect(invite.ok && (await db.inviteTokens.get(invite.createdId!))?.token).toBe("T".repeat(43));
	});

	test("a refusal changes nothing", async () => {
		const { db, commit } = await setup();
		const plan = await commit({ groupId: "g", type: "removePerson", memberId: "nobody" });
		expect(plan).toMatchObject({ ok: false, code: "HS422" });
		expect(await db.outbox.count()).toBe(0);
	});
});

describe("Dexie version 2", () => {
	test("upgrades version 1 rows and starts the cursors again", async () => {
		const indexedDB = new IDBFactory();
		const v1 = new Dexie("upgrade-test", { indexedDB, IDBKeyRange });
		v1.version(1).stores({
			groups: "id",
			members: "id, groupId",
			outbox: "++seq, &id",
			cursors: "groupId",
			meta: "key",
		});
		await v1.open();
		await v1
			.table("groups")
			.put({
				id: "g",
				name: "Trip",
				baseCurrency: "CAD",
				createdBy: "u",
				createdAt: "x",
				deletedAt: null,
				rowVersion: 3,
			});
		await v1
			.table("members")
			.put({ id: "m", groupId: "g", userId: "u", displayName: "A", role: "owner", deletedAt: null, rowVersion: 3 });
		await v1.table("cursors").put({ groupId: "g", version: 3 });
		v1.close();

		const db = new LocalDb("upgrade-test", { indexedDB, IDBKeyRange });
		await db.open();
		expect(await db.groups.get("g")).toEqual({
			id: "g",
			name: "Trip",
			createdBy: "u",
			createdAt: "x",
			deletedAt: null,
			completedAt: null,
			completedByMemberId: null,
			rowVersion: 3,
		});
		expect((await db.members.get("m"))?.joinedAt).toBeNull();
		expect(await db.cursors.count()).toBe(0);
		expect(await db.entries.count()).toBe(0);
	});
});
