import { describe, expect, test } from "bun:test";

import {
	computeShares,
	summarizeGroup,
	validateEntry,
	type EntryDraft,
	type Item,
	type LedgerEntry,
	type LedgerMember,
	type PaymentStatus,
	type Share,
} from "@/lib/ledger";
import { LEDGER_CASES } from "../fixtures/ledger-cases";

const idOf = (name: string) => `id-${name}`;
const nameOf = (id: string) => id.slice(3);
const membersOf = (names: string[], hasLogin = true): LedgerMember[] =>
	names.map((name) => ({ id: idOf(name), displayName: name, hasLogin }));

const bill = (shares: Share[], deletedAt: string | null = null): LedgerEntry => ({
	kind: "expense",
	deletedAt,
	paymentStatus: null,
	shares,
});

const payment = (from: string, to: string, amountCents: number, status: PaymentStatus): LedgerEntry => ({
	kind: "payment",
	deletedAt: null,
	paymentStatus: status,
	shares: computeShares([{ id: "p", amountCents, paidBy: from, splitAmong: [to] }]),
});

describe("the shared ledger case table", () => {
	for (const ledgerCase of LEDGER_CASES) {
		const items: Item[] = ledgerCase.items.map((item, i) => ({
			id: `item-${i}`,
			amountCents: item.amountCents,
			paidBy: idOf(item.paidBy),
			splitAmong: item.splitAmong.map(idOf),
		}));

		test(`computeShares: ${ledgerCase.name}`, () => {
			const byName = (record: Record<string, number>) =>
				Object.fromEntries(Object.entries(record).map(([id, cents]) => [nameOf(id), cents]));
			const got = computeShares(items).map((share) => ({
				name: nameOf(share.memberId),
				paid: share.paidCents,
				owed: share.owedCents,
				parts: byName(share.owedTo),
			}));
			const want = Object.keys(ledgerCase.paid).map((name) => ({
				name,
				paid: ledgerCase.paid[name],
				owed: ledgerCase.owed[name],
				parts: ledgerCase.parts[name],
			}));
			expect(got).toEqual(want);
		});

		test(`summarizeGroup: ${ledgerCase.name}`, () => {
			const summary = summarizeGroup([bill(computeShares(items))], membersOf(ledgerCase.members));
			expect(Object.fromEntries(summary.people.map((p) => [nameOf(p.memberId), p.balanceCents]))).toEqual(
				ledgerCase.balances
			);
			expect(
				summary.debts.map((debt) => ({
					from: nameOf(debt.fromMemberId),
					to: nameOf(debt.toMemberId),
					amountCents: debt.amountCents,
				}))
			).toEqual(ledgerCase.debts);
		});
	}
});

// mulberry32: a small fixed-seed PRNG, so the random cases are the same on every run.
function random(seed: number) {
	let a = seed;
	const next = () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
	const pick = <T>(list: T[]) => list[int(0, list.length - 1)];
	const subset = <T>(list: T[]) => {
		const shuffled = [...list].sort(() => next() - 0.5);
		return shuffled.slice(0, int(1, list.length));
	};
	return { int, pick, subset };
}

function randomBill(rng: ReturnType<typeof random>): { members: string[]; items: Item[] } {
	const members = Array.from({ length: rng.int(1, 6) }, (_, i) => `m${i}`);
	const items = Array.from({ length: rng.int(1, 8) }, (_, i) => ({
		id: `i${i}`,
		amountCents: rng.int(1, 100_000),
		paidBy: rng.pick(members),
		splitAmong: rng.subset(members),
	}));
	return { members, items };
}

describe("computeShares invariants over 1 000 seeded random bills", () => {
	const rng = random(20261104);
	const bills = Array.from({ length: 1000 }, () => randomBill(rng));

	test("everything adds up, nothing is negative, and each part is within a cent of exact", () => {
		for (const { items } of bills) {
			const shares = computeShares(items);
			const total = items.reduce((sum, item) => sum + item.amountCents, 0);
			expect(shares.reduce((sum, s) => sum + s.paidCents, 0)).toBe(total);
			expect(shares.reduce((sum, s) => sum + s.owedCents, 0)).toBe(total);
			expect(new Set(shares.map((s) => s.memberId)).size).toBe(shares.length);

			for (const share of shares) {
				expect(share.owedCents).toBeGreaterThanOrEqual(0);
				expect(Object.values(share.owedTo).reduce((sum, cents) => sum + cents, 0)).toBe(share.owedCents);
				for (const [payer, cents] of Object.entries(share.owedTo)) {
					expect(cents).toBeGreaterThan(0);
					if (payer === share.memberId) continue; // the payer absorbs the rounding
					const exact = items
						.filter((item) => item.paidBy === payer && item.splitAmong.includes(share.memberId))
						.reduce((sum, item) => sum + item.amountCents / item.splitAmong.length, 0);
					expect(Math.abs(cents - exact)).toBeLessThanOrEqual(1 + 1e-6);
				}
			}

			// What each payer is owed, in parts, is exactly what they paid.
			for (const payer of new Set(items.map((item) => item.paidBy))) {
				const paid = items.filter((item) => item.paidBy === payer).reduce((sum, item) => sum + item.amountCents, 0);
				expect(shares.reduce((sum, s) => sum + (s.owedTo[payer] ?? 0), 0)).toBe(paid);
			}
		}
	});

	test("the same items always give the same shares", () => {
		for (const { items } of bills.slice(0, 200)) {
			expect(computeShares(structuredClone(items))).toEqual(computeShares(items));
		}
	});

	test("debts net to each person's balance, and balances add up to 0", () => {
		const rng2 = random(7);
		for (let round = 0; round < 200; round++) {
			const members = Array.from({ length: rng2.int(2, 6) }, (_, i) => `m${i}`);
			const entries: LedgerEntry[] = [];
			for (let i = rng2.int(1, 5); i > 0; i--) {
				const items = Array.from({ length: rng2.int(1, 4) }, (_, k) => ({
					id: `i${k}`,
					amountCents: rng2.int(1, 100_000),
					paidBy: rng2.pick(members),
					splitAmong: rng2.subset(members),
				}));
				entries.push(bill(computeShares(items), rng2.int(0, 5) === 0 ? "2026-11-04T00:00:00.000Z" : null));
			}
			for (let i = rng2.int(0, 4); i > 0; i--) {
				const [from, to] = rng2.subset(members).concat(members);
				if (from === to) continue;
				const status = rng2.pick<PaymentStatus>(["pending", "confirmed", "declined", "undone"]);
				entries.push(payment(from, to, rng2.int(1, 50_000), status));
			}

			const summary = summarizeGroup(
				entries,
				members.map((id) => ({ id, displayName: id, hasLogin: true }))
			);
			expect(summary.people.reduce((sum, p) => sum + p.balanceCents, 0)).toBe(0);
			for (const person of summary.people) {
				const owedToThem = summary.debts.filter((d) => d.toMemberId === person.memberId);
				const theyOwe = summary.debts.filter((d) => d.fromMemberId === person.memberId);
				const net =
					owedToThem.reduce((sum, d) => sum + d.amountCents, 0) - theyOwe.reduce((sum, d) => sum + d.amountCents, 0);
				expect(net).toBe(person.balanceCents);
			}
			for (const debt of summary.debts) expect(debt.amountCents).toBeGreaterThan(0);
		}
	});
});

describe("computeShares preconditions", () => {
	test("malformed items are a programming error", () => {
		expect(() => computeShares([])).toThrow(RangeError);
		expect(() => computeShares([{ id: "a", amountCents: 0, paidBy: "x", splitAmong: ["x"] }])).toThrow(RangeError);
		expect(() => computeShares([{ id: "a", amountCents: 1.5, paidBy: "x", splitAmong: ["x"] }])).toThrow(RangeError);
		expect(() => computeShares([{ id: "a", amountCents: 100, paidBy: "x", splitAmong: [] }])).toThrow(RangeError);
		expect(() => computeShares([{ id: "a", amountCents: 100, paidBy: "x", splitAmong: ["y", "y"] }])).toThrow(
			RangeError
		);
	});
});

// The spec's Dinner example: Alex paid 9000 for Alex, Sam and Jo.
describe("summarizeGroup with handshake payments", () => {
	const members = membersOf(["Alex", "Sam", "Jo"]);
	const dinner = bill(
		computeShares([
			{ id: "d", amountCents: 9000, paidBy: idOf("Alex"), splitAmong: [idOf("Alex"), idOf("Sam"), idOf("Jo")] },
		])
	);
	const debtsOf = (entries: LedgerEntry[]) =>
		summarizeGroup(entries, members).debts.map(
			(d) => `${nameOf(d.fromMemberId)}→${nameOf(d.toMemberId)} ${d.amountCents}`
		);
	const balancesOf = (entries: LedgerEntry[]) =>
		Object.fromEntries(
			summarizeGroup(entries, members).people.map((p) => [nameOf(p.memberId), [p.balanceCents, p.state]])
		);

	test("a pending payment changes nothing", () => {
		const pending = [dinner, payment(idOf("Sam"), idOf("Alex"), 3000, "pending")];
		expect(debtsOf(pending)).toEqual(["Jo→Alex 3000", "Sam→Alex 3000"]);
		expect(balancesOf(pending)).toEqual({ Alex: [6000, "owed"], Jo: [-3000, "owes"], Sam: [-3000, "owes"] });
	});

	test("a confirmed payment settles the pair", () => {
		const confirmed = [dinner, payment(idOf("Sam"), idOf("Alex"), 3000, "confirmed")];
		expect(debtsOf(confirmed)).toEqual(["Jo→Alex 3000"]);
		expect(balancesOf(confirmed)).toEqual({ Alex: [3000, "owed"], Jo: [-3000, "owes"], Sam: [0, "settled"] });
	});

	test("declined and undone payments never count", () => {
		for (const status of ["declined", "undone"] as const) {
			expect(debtsOf([dinner, payment(idOf("Sam"), idOf("Alex"), 3000, status)])).toEqual([
				"Jo→Alex 3000",
				"Sam→Alex 3000",
			]);
		}
	});

	test("a partial payment leaves the rest", () => {
		expect(debtsOf([dinner, payment(idOf("Sam"), idOf("Alex"), 2000, "confirmed")])).toEqual([
			"Jo→Alex 3000",
			"Sam→Alex 1000",
		]);
	});

	test("deleted bills don't count", () => {
		expect(debtsOf([bill(dinner.shares, "2026-11-04T00:00:00.000Z")])).toEqual([]);
	});

	test("people are sorted by name, and debts by debtor then creditor name", () => {
		const shares = computeShares([
			{ id: "1", amountCents: 600, paidBy: idOf("Sam"), splitAmong: [idOf("Sam"), idOf("jo"), idOf("Alex")] },
			{ id: "2", amountCents: 600, paidBy: idOf("Alex"), splitAmong: [idOf("jo")] },
		]);
		const summary = summarizeGroup([bill(shares)], membersOf(["Sam", "jo", "Alex"]));
		expect(summary.people.map((p) => nameOf(p.memberId))).toEqual(["Alex", "jo", "Sam"]);
		expect(summary.debts.map((d) => `${nameOf(d.fromMemberId)}→${nameOf(d.toMemberId)}`)).toEqual([
			"Alex→Sam",
			"jo→Alex",
			"jo→Sam",
		]);
	});

	test("someone not in members is a programming error", () => {
		expect(() => summarizeGroup([dinner], membersOf(["Alex", "Sam"]))).toThrow(RangeError);
	});
});

describe("validateEntry", () => {
	const members = membersOf(["Alex", "Jo", "Sam"]);
	const items: Item[] = [
		{ id: "i1", amountCents: 1000, paidBy: idOf("Sam"), splitAmong: [idOf("Alex"), idOf("Jo"), idOf("Sam")] },
	];
	const good: EntryDraft = {
		kind: "expense",
		description: "Dinner",
		amountCents: 1000,
		entryDate: "2026-11-04",
		notes: null,
		items,
		shares: computeShares(items),
	};
	const goodPayment: EntryDraft = {
		kind: "payment",
		description: "",
		amountCents: 333,
		entryDate: "2026-11-04",
		notes: null,
		items: null,
		shares: computeShares([{ id: "p", amountCents: 333, paidBy: idOf("Alex"), splitAmong: [idOf("Sam")] }]),
	};
	const fails = (draft: unknown) => expect(validateEntry(draft as EntryDraft, members)).not.toEqual([]);

	test("accepts a good bill and a good payment", () => {
		expect(validateEntry(good, members)).toEqual([]);
		expect(validateEntry(goodPayment, members)).toEqual([]);
	});

	test("never throws on garbage", () => {
		for (const garbage of [null, 7, "x", [], {}, { ...good, items: [null] }, { ...good, shares: [7] }]) {
			expect(() => validateEntry(garbage as unknown as EntryDraft, members)).not.toThrow();
			fails(garbage);
		}
	});

	// One failing draft per HS422 rule in the spec's "Entry checks on the server".
	const cases: [string, unknown][] = [
		["an unknown kind", { ...good, kind: "refund" }],
		["a blank description", { ...good, description: "   " }],
		["a description over 120 characters", { ...good, description: "x".repeat(121) }],
		["a zero amount", { ...good, amountCents: 0 }],
		["a negative amount", { ...good, amountCents: -1000 }],
		["a fractional amount", { ...good, amountCents: 10.5 }],
		["an amount over 10^12", { ...good, amountCents: 1_000_000_000_001 }],
		["a date that isn't a day", { ...good, entryDate: "2026-02-30" }],
		["a date in another format", { ...good, entryDate: "04/11/2026" }],
		["notes over 1000 characters", { ...good, notes: "x".repeat(1001) }],
		["a bill with no items", { ...good, items: [] }],
		["a bill with 51 items", { ...good, items: Array.from({ length: 51 }, () => items[0]) }],
		["an item with nobody to split it", { ...good, items: [{ ...items[0], splitAmong: [] }] }],
		["someone twice in a split", { ...good, items: [{ ...items[0], splitAmong: [idOf("Alex"), idOf("Alex")] }] }],
		["an item with a zero amount", { ...good, items: [{ ...items[0], amountCents: 0 }] }],
		["an item description over 60 characters", { ...good, items: [{ ...items[0], description: "x".repeat(61) }] }],
		["items that don't add up to the total", { ...good, amountCents: 1001 }],
		["a payer not in the group", { ...good, items: [{ ...items[0], paidBy: "stranger" }] }],
		[
			"someone in the split not in the group",
			{ ...good, items: [{ ...items[0], splitAmong: [idOf("Alex"), "stranger"] }] },
		],
		["no shares", { ...good, shares: [] }],
		[
			"a share with a negative amount",
			{ ...good, shares: good.shares.map((s, i) => (i === 0 ? { ...s, paidCents: -1 } : s)) },
		],
		["someone twice in the shares", { ...good, shares: [...good.shares, good.shares[0]] }],
		[
			"shares one cent off the items",
			{
				...good,
				shares: good.shares.map((s) =>
					s.memberId === idOf("Alex")
						? { ...s, owedCents: 334, owedTo: { [idOf("Sam")]: 334 } }
						: s.memberId === idOf("Sam")
							? { ...s, owedCents: 333, owedTo: { [idOf("Sam")]: 333 } }
							: s
				),
			},
		],
		[
			"owedTo pointing at the wrong payer",
			{
				...good,
				shares: good.shares.map((s) => (s.memberId === idOf("Alex") ? { ...s, owedTo: { [idOf("Jo")]: 333 } } : s)),
			},
		],
		[
			"a share for someone not in the group",
			{ ...good, shares: [...good.shares, { memberId: "stranger", paidCents: 0, owedCents: 0, owedTo: {} }] },
		],
		[
			"a payment to yourself",
			{
				...goodPayment,
				shares: computeShares([{ id: "p", amountCents: 333, paidBy: idOf("Alex"), splitAmong: [idOf("Alex")] }]),
			},
		],
		[
			"a payment with someone not in the group",
			{
				...goodPayment,
				shares: computeShares([{ id: "p", amountCents: 333, paidBy: idOf("Alex"), splitAmong: ["stranger"] }]),
			},
		],
		["a payment with items", { ...goodPayment, items }],
	];
	for (const [name, draft] of cases) test(`rejects ${name}`, () => fails(draft));
});
