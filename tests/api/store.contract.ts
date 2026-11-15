import { beforeAll, describe, expect, test } from "bun:test";

import { ApiStoreError, type ApiStore } from "../../src/server/api-v1/store";

// One scenario, seeded through each ApiStore adapter's own writer, and the seam's invariants
// (docs/architecture.md §9.11) checked against both. Expected numbers are worked out by hand.

export type BillItem = { amountCents: number; paidBy: string; splitAmong: string[] };

// What a scenario can do, the way people would do it in the app. Names are user names; ids come back.
export interface ApiSeeder {
	user(name: string): Promise<string>;
	group(owner: string, name: string): Promise<string>;
	join(user: string, groupId: string): Promise<string>;
	addPerson(by: string, groupId: string, name: string): Promise<string>;
	memberId(user: string, groupId: string): Promise<string>;
	bill(by: string, groupId: string, item: BillItem): Promise<string>;
	// Recorded by `by`; confirmed by `confirmBy` when given. With a side who can't answer it counts at once.
	payment(
		by: string,
		groupId: string,
		from: string,
		to: string,
		amountCents: number,
		confirmBy?: string
	): Promise<string>;
	// Each as `by` would do it in the app: delete a bill, decline a payment waiting for them, undo their own.
	deleteBill(by: string, groupId: string, entryId: string): Promise<void>;
	decline(by: string, groupId: string, entryId: string): Promise<void>;
	undo(by: string, groupId: string, entryId: string): Promise<void>;
	leave(user: string, groupId: string): Promise<void>;
	deleteGroup(owner: string, groupId: string): Promise<void>;
	// A new token for the user; returns its hash, as the handler would send it.
	token(user: string): Promise<{ hash: string; revoke(): Promise<void> }>;
	headVersion(groupId: string): Promise<number>;
}

export type ApiWorld = { store: ApiStore; seed: ApiSeeder; cleanup?(): Promise<void> };

const UNKNOWN_GROUP = "00000000-0000-4000-8000-000000000000";

async function storeError(promise: Promise<unknown>): Promise<ApiStoreError> {
	try {
		await promise;
	} catch (failure) {
		if (failure instanceof ApiStoreError) return failure;
		throw failure;
	}
	throw new Error("expected an ApiStoreError");
}

export function describeApiStore(name: string, makeWorld: () => Promise<ApiWorld>, options: { skip?: boolean } = {}) {
	const suite = options.skip ? describe.skip : describe;

	suite(`ApiStore contract: ${name}`, () => {
		let world: ApiWorld;
		let store: ApiStore;
		let seed: ApiSeeder;
		const ids = {} as Record<
			| "sam"
			| "alex"
			| "jo"
			| "kim"
			| "banff"
			| "flat"
			| "kims"
			| "gone"
			| "dinner"
			| "alexPaid"
			| "joPending"
			| "samPaidLee"
			| "lee"
			| "cabin"
			| "cabinConfirmed",
			string
		>;
		const member = {} as Record<"samBanff" | "alexBanff" | "joBanff" | "samFlat" | "kimCabin" | "joCabin", string>;
		let sam: string;
		let kim: string;

		beforeAll(async () => {
			world = await makeWorld();
			({ store, seed } = world);
			ids.sam = await seed.user("Sam");
			ids.alex = await seed.user("Alex");
			ids.jo = await seed.user("Jo");
			ids.kim = await seed.user("Kim");

			// Banff trip (Sam owns): the $10 dinner Sam paid for Alex, Jo and Sam; Alex paid back 333 and Sam
			// confirmed; Jo's 333 still waits for Sam.
			ids.banff = await seed.group("Sam", "Banff trip");
			member.samBanff = await seed.memberId("Sam", ids.banff);
			member.alexBanff = await seed.join("Alex", ids.banff);
			member.joBanff = await seed.join("Jo", ids.banff);
			ids.dinner = await seed.bill("Sam", ids.banff, {
				amountCents: 1000,
				paidBy: member.samBanff,
				splitAmong: [member.alexBanff, member.joBanff, member.samBanff],
			});
			ids.alexPaid = await seed.payment("Alex", ids.banff, member.alexBanff, member.samBanff, 333, "Sam");
			ids.joPending = await seed.payment("Jo", ids.banff, member.joBanff, member.samBanff, 333);

			// apartment (Alex owns, lower-case to check the case-insensitive sort): Lee, name-only, paid 600 for
			// Sam and Lee; Sam paid Lee back 300, which counts at once.
			ids.flat = await seed.group("Alex", "apartment");
			member.samFlat = await seed.join("Sam", ids.flat);
			ids.lee = await seed.addPerson("Alex", ids.flat, "Lee");
			await seed.bill("Alex", ids.flat, { amountCents: 600, paidBy: ids.lee, splitAmong: [member.samFlat, ids.lee] });
			ids.samPaidLee = await seed.payment("Sam", ids.flat, member.samFlat, ids.lee, 300);

			// Kim's own group, which Sam can't see; and a group Sam was in that is deleted.
			ids.kims = await seed.group("Kim", "Kim's");
			ids.gone = await seed.group("Sam", "Gone");
			await seed.deleteGroup("Sam", ids.gone);

			// Cabin (Kim owns, Sam isn't in it): one entry of each kind that counts or doesn't. Kim paid the $40.00
			// lunch for Kim and Jo; Jo's $10.00 taxi was deleted; Jo's payments to Kim: 500 declined by Kim, 700
			// undone by Jo, 1200 confirmed by Kim, 900 still waiting.
			ids.cabin = await seed.group("Kim", "Cabin");
			member.kimCabin = await seed.memberId("Kim", ids.cabin);
			member.joCabin = await seed.join("Jo", ids.cabin);
			const both = [member.kimCabin, member.joCabin];
			await seed.bill("Kim", ids.cabin, { amountCents: 4000, paidBy: member.kimCabin, splitAmong: both });
			const taxi = await seed.bill("Jo", ids.cabin, { amountCents: 1000, paidBy: member.joCabin, splitAmong: both });
			await seed.deleteBill("Jo", ids.cabin, taxi);
			const declined = await seed.payment("Jo", ids.cabin, member.joCabin, member.kimCabin, 500);
			await seed.decline("Kim", ids.cabin, declined);
			const undone = await seed.payment("Jo", ids.cabin, member.joCabin, member.kimCabin, 700);
			await seed.undo("Jo", ids.cabin, undone);
			ids.cabinConfirmed = await seed.payment("Jo", ids.cabin, member.joCabin, member.kimCabin, 1200, "Kim");
			await seed.payment("Jo", ids.cabin, member.joCabin, member.kimCabin, 900);

			sam = (await seed.token("Sam")).hash;
			kim = (await seed.token("Kim")).hash;
		});

		test("an unknown or revoked token is HS401", async () => {
			expect((await storeError(store.me("0".repeat(64)))).code).toBe("HS401");
			const token = await seed.token("Jo");
			expect((await store.me(token.hash)).displayName).toBe("Jo");
			await token.revoke();
			expect((await storeError(store.me(token.hash))).code).toBe("HS401");
			expect((await storeError(store.groups(token.hash))).code).toBe("HS401");
		});

		test("me is the token's owner", async () => {
			expect(await store.me(sam)).toEqual({ userId: ids.sam, displayName: "Sam" });
		});

		test("groups: the owner's live groups by name, with their totals over what counts", async () => {
			const groups = await store.groups(sam);
			expect(groups.map((g) => g.name)).toEqual(["apartment", "Banff trip"]);
			const [flat, banff] = groups;
			// Banff: paid 1000; owed 334 of the dinner plus the 333 Alex paid back. Jo's pending 333 doesn't count.
			expect(banff).toMatchObject({
				id: ids.banff,
				role: "owner",
				memberId: member.samBanff,
				paidCents: 1000,
				owedCents: 667,
				completedAt: null,
			});
			// apartment: owed 300 of Lee's bill, paid 300 back.
			expect(flat).toMatchObject({
				id: ids.flat,
				role: "member",
				memberId: member.samFlat,
				paidCents: 300,
				owedCents: 300,
				completedAt: null,
			});
			for (const group of groups) expect(Number.isNaN(Date.parse(group.updatedAt))).toBe(false);
		});

		test("group: every member with totals and owedTo over what counts", async () => {
			const banff = await store.group(sam, ids.banff);
			expect(banff).toMatchObject({
				id: ids.banff,
				name: "Banff trip",
				role: "owner",
				memberId: member.samBanff,
				paidCents: 1000,
				owedCents: 667,
			});
			expect(banff.members).toEqual([
				{
					memberId: member.alexBanff,
					displayName: "Alex",
					active: true,
					paidCents: 333,
					owedCents: 333,
					owedTo: { [member.samBanff]: 333 },
				},
				{
					memberId: member.joBanff,
					displayName: "Jo",
					active: true,
					paidCents: 0,
					owedCents: 333,
					owedTo: { [member.samBanff]: 333 },
				},
				{
					memberId: member.samBanff,
					displayName: "Sam",
					active: true,
					paidCents: 1000,
					owedCents: 667,
					owedTo: { [member.samBanff]: 334, [member.alexBanff]: 333 },
				},
			]);
		});

		test("what counts: a deleted bill and declined, undone and pending payments don't; a confirmed one does", async () => {
			const cabin = await store.group(kim, ids.cabin);
			// Kim: paid the 4000 lunch; owes 2000 of it, plus the 1200 Jo paid back.
			expect(cabin).toMatchObject({ memberId: member.kimCabin, paidCents: 4000, owedCents: 3200 });
			expect(cabin.members).toEqual([
				{
					memberId: member.joCabin,
					displayName: "Jo",
					active: true,
					paidCents: 1200,
					owedCents: 2000,
					owedTo: { [member.kimCabin]: 2000 },
				},
				{
					memberId: member.kimCabin,
					displayName: "Kim",
					active: true,
					paidCents: 4000,
					owedCents: 3200,
					owedTo: { [member.kimCabin]: 2000, [member.joCabin]: 1200 },
				},
			]);
			expect((await store.groups(kim)).find((g) => g.id === ids.cabin)).toMatchObject({
				paidCents: 4000,
				owedCents: 3200,
			});
			const page = await store.payments(kim, { groupId: ids.cabin, cursor: {}, limit: 100 });
			expect(page.payments.map((p) => [p.id, p.direction, p.amountCents])).toEqual([
				[ids.cabinConfirmed, "received", 1200],
			]);
		});

		test("group: unknown, deleted and other people's groups are HS404", async () => {
			for (const groupId of [UNKNOWN_GROUP, ids.gone, ids.kims]) {
				expect((await storeError(store.group(sam, groupId))).code).toBe("HS404");
			}
		});

		test("payments: only those that count and involve the owner, with direction and counterparty", async () => {
			const page = await store.payments(sam, { groupId: null, cursor: {}, limit: 100 });
			const byId = Object.fromEntries(page.payments.map((p) => [p.id, p]));
			expect(Object.keys(byId).sort()).toEqual([ids.alexPaid, ids.samPaidLee].sort());
			expect(byId[ids.alexPaid]).toMatchObject({
				groupId: ids.banff,
				groupName: "Banff trip",
				direction: "received",
				counterpartyMemberId: member.alexBanff,
				counterpartyName: "Alex",
				amountCents: 333,
				notes: null,
			});
			expect(byId[ids.samPaidLee]).toMatchObject({
				groupId: ids.flat,
				groupName: "apartment",
				direction: "sent",
				counterpartyMemberId: ids.lee,
				counterpartyName: "Lee",
				amountCents: 300,
			});
			for (const payment of page.payments) {
				expect(payment.entryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
				expect(Number.isNaN(Date.parse(payment.confirmedAt))).toBe(false);
			}
			expect(page.payments.map((p) => p.groupId)).toEqual([...page.payments.map((p) => p.groupId)].sort());
			expect(page.hasMore).toBe(false);
			expect(page.removedGroupIds).toEqual([]);
			expect(page.cursor).toEqual({
				[ids.banff]: await seed.headVersion(ids.banff),
				[ids.flat]: await seed.headVersion(ids.flat),
			});
		});

		test("payments: pages by group, and a fully read group's cursor is its head version", async () => {
			const [first, second] = [ids.banff, ids.flat].sort();
			const page1 = await store.payments(sam, { groupId: null, cursor: {}, limit: 1 });
			expect(page1.payments.map((p) => p.groupId)).toEqual([first]);
			expect(page1.hasMore).toBe(true);
			expect(page1.cursor).toEqual({ [first]: await seed.headVersion(first), [second]: 0 });

			const page2 = await store.payments(sam, { groupId: null, cursor: page1.cursor, limit: 1 });
			expect(page2.payments.map((p) => p.groupId)).toEqual([second]);
			expect(page2.hasMore).toBe(false);
			expect(page2.cursor).toEqual({
				[first]: await seed.headVersion(first),
				[second]: await seed.headVersion(second),
			});

			const page3 = await store.payments(sam, { groupId: null, cursor: page2.cursor, limit: 1 });
			expect(page3.payments).toEqual([]);
			expect(page3.hasMore).toBe(false);
		});

		test("payments: one group's feed, and HS404 for a group that isn't the owner's", async () => {
			const page = await store.payments(sam, { groupId: ids.banff, cursor: {}, limit: 100 });
			expect(page.payments.map((p) => p.id)).toEqual([ids.alexPaid]);
			expect(page.cursor).toEqual({ [ids.banff]: await seed.headVersion(ids.banff) });
			for (const groupId of [ids.kims, ids.gone, UNKNOWN_GROUP]) {
				expect((await storeError(store.payments(sam, { groupId, cursor: {}, limit: 100 }))).code).toBe("HS404");
			}
		});

		test("payments: a payment that starts to count later arrives with the next call", async () => {
			const before = await store.payments(sam, { groupId: null, cursor: {}, limit: 100 });
			const late = await seed.payment("Sam", ids.banff, member.samBanff, member.alexBanff, 100, "Alex");
			const after = await store.payments(sam, { groupId: null, cursor: before.cursor, limit: 100 });
			expect(after.payments.map((p) => [p.id, p.direction, p.counterpartyName])).toEqual([[late, "sent", "Alex"]]);
		});

		test("rate limit: 60 calls a minute; the 61st is HS429 with the seconds to wait; not-found calls count", async () => {
			const token = (await seed.token("Sam")).hash;
			for (let i = 0; i < 59; i++) await store.me(token);
			expect((await storeError(store.group(token, UNKNOWN_GROUP))).code).toBe("HS404");
			const limited = await storeError(store.me(token));
			expect(limited.code).toBe("HS429");
			expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1);
			expect(limited.retryAfterSeconds).toBeLessThanOrEqual(60);
			expect((await storeError(store.groups(token))).code).toBe("HS429");
		});

		test("payments: groups the owner left are reported once and leave the cursor", async () => {
			const before = await store.payments(sam, { groupId: null, cursor: {}, limit: 100 });
			await seed.leave("Sam", ids.flat);
			const after = await store.payments(sam, { groupId: null, cursor: before.cursor, limit: 100 });
			expect(after.removedGroupIds).toEqual([ids.flat]);
			expect(Object.keys(after.cursor)).toEqual([ids.banff]);
			expect((await store.groups(sam)).map((g) => g.id)).toEqual([ids.banff]);
			expect((await storeError(store.group(sam, ids.flat))).code).toBe("HS404");
		});

		test("cleanup", async () => {
			await world.cleanup?.();
		});
	});
}
