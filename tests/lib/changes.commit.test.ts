import "fake-indexeddb/auto";

import { beforeEach, describe, expect, test } from "bun:test";
import Dexie from "dexie";

import { createCommitter, type Commit, type Intent } from "@/lib/changes";
import { LocalDb } from "@/lib/local-db";
import { serverBill, serverGroup, serverMember } from "../support/memory-tables";

// Dexie may have looked for IndexedDB before fake-indexeddb installed it.
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const G = "g1";
let dbCount = 0;

let db: LocalDb;
let syncs: number;
let ids: string[];
let commit: Commit;

function committer(userId = "user-a", isAnonymous = false) {
	let n = 0;
	return createCommitter({
		db,
		userId,
		isAnonymous,
		requestSync: () => void syncs++,
		newId: () => ids.shift() ?? `id-${++n}`,
		now: () => new Date("2026-11-08T10:00:00.000Z"),
	});
}

beforeEach(async () => {
	db = new LocalDb(`changes-commit-${++dbCount}`);
	syncs = 0;
	ids = [];
	await db.groups.put(serverGroup({ id: G, createdBy: "user-a" }));
	await db.members.bulkPut([
		serverMember({ id: "alex", groupId: G, userId: "user-a", displayName: "Alex", role: "owner" }),
		serverMember({ id: "sam", groupId: G, userId: "user-s", displayName: "Sam", role: "member" }),
		serverMember({ id: "jo", groupId: G, userId: null, displayName: "Jo", role: "member", joinedAt: null }),
	]);
	commit = committer();
});

const outbox = async () => (await db.outbox.orderBy("seq").toArray()).map((e) => e.mutation);
const record = (to: string): Intent => ({
	type: "recordPayment",
	groupId: G,
	from: "alex",
	to,
	amountCents: 1500,
	entryDate: "2026-11-08",
	notes: null,
});

describe("commit", () => {
	test("two taps on Record payment queue one payment", async () => {
		const [first, second] = await Promise.all([commit(record("sam")), commit(record("sam"))]);

		expect(first.ok).toBe(true);
		expect(second).toEqual({
			ok: false,
			code: "HS409",
			reason: "A payment between these two is already waiting for an answer",
		});
		expect((await outbox()).map((m) => m.type)).toEqual(["payment.record"]);
		expect(await db.entries.where("groupId").equals(G).count()).toBe(1);
		expect(syncs).toBe(1);
	});

	test("a payment waits for someone who can answer, and counts at once for a name-only person", async () => {
		const toSam = await commit(record("sam"));
		const toJo = await commit(record("jo"));
		expect(toSam.ok && toJo.ok).toBe(true);
		if (!toSam.ok || !toJo.ok) return;

		expect(await db.entries.get(toSam.createdId!)).toMatchObject({ paymentStatus: "pending", confirmedAt: null });
		expect(await db.entries.get(toJo.createdId!)).toMatchObject({
			paymentStatus: "confirmed",
			confirmedAt: "2026-11-08T10:00:00.000Z",
			shares: [
				{ memberId: "jo", paidCents: 0, owedCents: 1500, owedTo: { alex: 1500 } },
				{ memberId: "alex", paidCents: 1500, owedCents: 0, owedTo: {} },
			],
		});
	});

	test("a failing write rolls back the rows and the outbox", async () => {
		// The mutation id is already queued, so outbox.add breaks its unique index after the row was applied.
		await db.outbox.add({ id: "taken", mutation: { id: "taken", at: "x", type: "group.delete", groupId: "other" } });
		ids = ["new-person", "taken"];

		await expect(commit({ type: "addPerson", groupId: G, displayName: "Lee" })).rejects.toThrow();

		expect(await db.members.get("new-person")).toBeUndefined();
		expect((await outbox()).map((m) => m.id)).toEqual(["taken"]);
		expect(syncs).toBe(0);
	});

	test("the outbox holds each commit's mutations in plan order", async () => {
		const plans = [];
		plans.push(await commit({ type: "addPerson", groupId: G, displayName: "Lee" }));
		plans.push(await commit({ type: "renameGroup", groupId: G, name: "Kyoto" }));
		plans.push(await commit(record("jo")));

		expect(await outbox()).toEqual(plans.flatMap((p) => (p.ok ? p.mutations : [])));
		expect((await outbox()).map((m) => m.type)).toEqual(["member.add", "group.rename", "payment.record"]);
		expect((await db.groups.get(G))?.name).toBe("Kyoto");
	});

	test("requestSync runs only when something was queued", async () => {
		// Refused: Sam is not the owner.
		const asSam = committer("user-s");
		expect(await asSam({ type: "renameGroup", groupId: G, name: "X" })).toMatchObject({ ok: false, code: "HS403" });
		expect(syncs).toBe(0);

		// Nothing to do: the group isn't completed.
		expect(await commit({ type: "reopenGroup", groupId: G })).toEqual({ ok: true, mutations: [], createdId: null });
		expect(syncs).toBe(0);
		expect(await db.outbox.count()).toBe(0);

		await commit({ type: "renameGroup", groupId: G, name: "Kyoto" });
		expect(syncs).toBe(1);
	});

	test("a group this device doesn't have, or has left, is refused", async () => {
		expect(await commit({ type: "renameGroup", groupId: "missing", name: "X" })).toEqual({
			ok: false,
			code: "HS403",
			reason: "You are not a member of this group",
		});
		expect(await committer("user-gone")({ type: "addPerson", groupId: G, displayName: "Lee" })).toMatchObject({
			code: "HS403",
		});
	});

	test("guests can't create groups", async () => {
		expect(await committer("user-g", true)({ type: "createGroup", name: "Trip", displayName: "Gus" })).toEqual({
			ok: false,
			code: "HS403",
			reason: "Guests can't create groups",
		});
		expect(await db.groups.count()).toBe(1);
	});

	test("createdId names the new group", async () => {
		const result = await commit({ type: "createGroup", name: "Japan 2027", displayName: "alex" });
		if (!result.ok) throw new Error(result.reason);

		expect(await db.groups.get(result.createdId!)).toMatchObject({ name: "Japan 2027", rowVersion: 0 });
		expect(await db.members.where("groupId").equals(result.createdId!).toArray()).toMatchObject([
			{ userId: "user-a", displayName: "alex", role: "owner" },
		]);
	});

	test("createdId names the new entry", async () => {
		const result = await commit({
			type: "addExpense",
			groupId: G,
			draft: {
				description: "Dinner",
				entryDate: "2026-11-07",
				notes: null,
				category: null,
				items: [{ id: "i1", amountCents: 2000, paidBy: "alex", splitAmong: ["alex", "sam"] }],
			},
		});
		if (!result.ok) throw new Error(result.reason);

		expect(await db.entries.get(result.createdId!)).toMatchObject({
			kind: "expense",
			amountCents: 2000,
			createdByMemberId: "alex",
			shares: [
				{ memberId: "alex", paidCents: 2000, owedCents: 1000, owedTo: { alex: 1000 } },
				{ memberId: "sam", paidCents: 0, owedCents: 1000, owedTo: { alex: 1000 } },
			],
		});
	});

	test("a second confirm is invisible", async () => {
		const asSam = committer("user-s");
		const recorded = await commit(record("sam"));
		if (!recorded.ok) throw new Error(recorded.reason);
		const entryId = recorded.createdId!;

		const [first, second] = await Promise.all([
			asSam({ type: "confirmPayment", groupId: G, entryId }),
			asSam({ type: "confirmPayment", groupId: G, entryId }),
		]);
		expect(first).toMatchObject({ ok: true, mutations: [{ type: "payment.confirm" }] });
		expect(second).toEqual({ ok: true, mutations: [], createdId: null });
		expect((await outbox()).map((m) => m.type)).toEqual(["payment.record", "payment.confirm"]);
		expect((await db.entries.get(entryId))?.paymentStatus).toBe("confirmed");
	});
});

describe("commit nudge", () => {
	test("stores the nudge here, queues it, and a second tap the same day is HS409", async () => {
		await db.entries.put(
			serverBill({
				id: "dinner",
				groupId: G,
				createdByMemberId: "alex",
				amountCents: 2000,
				items: [{ id: "i1", amountCents: 2000, paidBy: "alex", splitAmong: ["alex", "sam"] }],
				shares: [
					{ memberId: "alex", paidCents: 2000, owedCents: 1000, owedTo: { alex: 1000 } },
					{ memberId: "sam", paidCents: 0, owedCents: 1000, owedTo: { alex: 1000 } },
				],
			})
		);
		ids = ["nudge-1", "mutation-1"];

		expect(await commit({ type: "nudge", groupId: G, memberId: "sam" })).toMatchObject({
			ok: true,
			createdId: "nudge-1",
		});
		expect(await db.nudges.get("nudge-1")).toEqual({
			id: "nudge-1",
			groupId: G,
			fromMemberId: "alex",
			toMemberId: "sam",
			amountCents: 1000,
			createdAt: "2026-11-08T10:00:00.000Z",
			rowVersion: 0,
		});
		expect((await outbox()).map((m) => m.type)).toEqual(["nudge.send"]);

		expect(await commit({ type: "nudge", groupId: G, memberId: "sam" })).toEqual({
			ok: false,
			code: "HS409",
			reason: "You nudged Sam today",
		});
		expect(syncs).toBe(1);
	});
});
