import { describe, expect, test } from "bun:test";

import { computeShares, countsTowardsDebts, explainRounding, summarizeGroup, validateEntry } from "@/lib/ledger";
import type { EntryDraft, Item, LedgerEntry, LedgerMember, Share } from "@/lib/ledger";

import { LEDGER_CASES } from "../fixtures/ledger-cases";

const member = (id: string, displayName = id): LedgerMember => ({ id, displayName, hasLogin: true });
const item = (amountCents: number, paidBy: string, splitAmong: string[], id = "i"): Item => ({
	id,
	amountCents,
	paidBy,
	splitAmong,
});
const bill = (shares: Share[]): LedgerEntry => ({ kind: "expense", deletedAt: null, paymentStatus: null, shares });
const payment = (
	from: string,
	to: string,
	amountCents: number,
	paymentStatus: LedgerEntry["paymentStatus"]
): LedgerEntry => ({
	kind: "payment",
	deletedAt: null,
	paymentStatus,
	shares: computeShares([item(amountCents, from, [to])]),
});
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("the shared ledger case table", () => {
	for (const ledgerCase of LEDGER_CASES) {
		describe(ledgerCase.name, () => {
			const items = ledgerCase.items.map((x, i) => item(x.amountCents, x.paidBy, x.splitAmong, `i${i}`));
			const names = Object.keys(ledgerCase.paid);

			test("computeShares gives paid, owed and parts, in bill order", () => {
				const shares = computeShares(items);
				expect(shares.map((share) => share.memberId)).toEqual(names);
				for (const share of shares) {
					expect(share.paidCents).toBe(ledgerCase.paid[share.memberId]);
					expect(share.owedCents).toBe(ledgerCase.owed[share.memberId]);
					expect(share.owedTo).toEqual(ledgerCase.parts[share.memberId]);
				}
			});

			test("summarizeGroup gives balances and pairwise debts", () => {
				const summary = summarizeGroup(
					[bill(computeShares(items))],
					ledgerCase.members.map((name) => member(name))
				);
				expect(Object.fromEntries(summary.people.map((person) => [person.memberId, person.balanceCents]))).toEqual(
					ledgerCase.balances
				);
				expect(
					summary.debts.map((debt) => ({ from: debt.fromMemberId, to: debt.toMemberId, amountCents: debt.amountCents }))
				).toEqual(ledgerCase.debts);
			});
		});
	}
});

describe("computeShares", () => {
	test("throws RangeError on malformed items", () => {
		expect(() => computeShares([])).toThrow(RangeError);
		expect(() => computeShares([item(0, "a", ["a"])])).toThrow(RangeError);
		expect(() => computeShares([item(-5, "a", ["a"])])).toThrow(RangeError);
		expect(() => computeShares([item(1.5, "a", ["a"])])).toThrow(RangeError);
		expect(() => computeShares([item(100, "a", [])])).toThrow(RangeError);
		expect(() => computeShares([item(100, "a", ["a", "a"])])).toThrow(RangeError);
	});

	test("a denominator beyond 2^53 still adds up exactly", () => {
		const people = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s"];
		const items = [7, 11, 13, 17, 19].map((n, k) => item(100_000 * (k + 1), "a", people.slice(0, n + 2), `i${k}`));
		const shares = computeShares(items);
		const total = sum(items.map((x) => x.amountCents));
		expect(sum(shares.map((share) => share.paidCents))).toBe(total);
		expect(sum(shares.map((share) => share.owedCents))).toBe(total);
	});
});

// Mulberry32, so the random bills are the same on every run.
function prng(seed: number) {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomBill(random: () => number): Item[] {
	const pick = (n: number) => Math.floor(random() * n);
	const people = Array.from({ length: 1 + pick(6) }, (_, k) => `m${k}`);
	return Array.from({ length: 1 + pick(8) }, (_, k) => {
		const splitAmong = people.filter(() => random() < 0.6);
		if (splitAmong.length === 0) splitAmong.push(people[pick(people.length)]);
		return item(1 + pick(100_000), people[pick(people.length)], splitAmong, `i${k}`);
	});
}

describe("seeded invariants", () => {
	const random = prng(20261104);
	const bills = Array.from({ length: 1000 }, () => randomBill(random));

	test("every bill adds up, is non-negative, near its exact share, and is deterministic", () => {
		for (const items of bills) {
			const shares = computeShares(items);
			const total = sum(items.map((x) => x.amountCents));

			expect(sum(shares.map((share) => share.paidCents))).toBe(total);
			expect(sum(shares.map((share) => share.owedCents))).toBe(total);
			expect(computeShares(items)).toEqual(shares);
			expect(new Set(shares.map((share) => share.memberId)).size).toBe(shares.length);

			for (const share of shares) {
				expect(share.owedCents).toBeGreaterThanOrEqual(0);
				expect(sum(Object.values(share.owedTo))).toBe(share.owedCents);
				for (const cents of Object.values(share.owedTo)) expect(cents).toBeGreaterThan(0);
			}

			for (const payer of new Set(items.map((x) => x.paidBy))) {
				const payerItems = items.filter((x) => x.paidBy === payer);
				expect(sum(shares.map((share) => share.owedTo[payer] ?? 0))).toBe(sum(payerItems.map((x) => x.amountCents)));
				for (const share of shares) {
					if (share.memberId === payer) continue;
					const exact = sum(
						payerItems
							.filter((x) => x.splitAmong.includes(share.memberId))
							.map((x) => x.amountCents / x.splitAmong.length)
					);
					expect(Math.abs((share.owedTo[payer] ?? 0) - exact)).toBeLessThanOrEqual(1);
				}
			}
		}
	});

	test("balances add up to 0 and each person's debts net to their balance", () => {
		const random2 = prng(7);
		for (let round = 0; round < 200; round++) {
			const entries: LedgerEntry[] = [];
			const ids = new Set<string>();
			for (let k = 0; k < 1 + Math.floor(random2() * 4); k++) {
				const items = randomBill(random2);
				entries.push(bill(computeShares(items)));
				for (const x of items) [x.paidBy, ...x.splitAmong].forEach((id) => ids.add(id));
			}
			const people = [...ids];
			if (people.length > 1) {
				entries.push(payment(people[0], people[1], 1 + Math.floor(random2() * 5000), "confirmed"));
			}

			const summary = summarizeGroup(
				entries,
				people.map((id) => member(id))
			);
			expect(sum(summary.people.map((person) => person.balanceCents))).toBe(0);
			for (const person of summary.people) {
				const owedToThem = sum(summary.debts.filter((d) => d.toMemberId === person.memberId).map((d) => d.amountCents));
				const theyOwe = sum(summary.debts.filter((d) => d.fromMemberId === person.memberId).map((d) => d.amountCents));
				expect(owedToThem - theyOwe).toBe(person.balanceCents);
			}
			for (const debt of summary.debts) {
				expect(debt.amountCents).toBeGreaterThan(0);
				expect(
					summary.debts.some((d) => d.fromMemberId === debt.toMemberId && d.toMemberId === debt.fromMemberId)
				).toBe(false);
			}
		}
	});
});

describe("explainRounding", () => {
	const moves = (items: Item[]) => explainRounding(items, computeShares(items));

	test("$23.00 paid by Alex split three ways: Alex's part takes 1¢ less ($7.66 against $7.67)", () => {
		expect(moves([item(2300, "alex", ["alex", "jo", "sam"])])).toEqual([
			{ memberId: "alex", payerId: "alex", cents: -1 },
		]);
	});

	test("$10.00 paid by Sam split three ways: Sam covers the missing 1¢", () => {
		expect(moves([item(1000, "sam", ["alex", "jo", "sam"])])).toEqual([{ memberId: "sam", payerId: "sam", cents: 1 }]);
	});

	test("an even split moves nothing", () => {
		expect(moves([item(5000, "alex", ["alex", "jo", "sam", "kim", "lee"])])).toEqual([]);
	});

	test("a payer outside a $20.00 split: 1¢ comes off the first person's part", () => {
		// 6.666… rounds to 6.67 each (20.01); Sam's own part can't go below 0, so Alex (listed first) drops to 6.66.
		expect(moves([item(2000, "sam", ["alex", "jo", "kim"])])).toEqual([
			{ memberId: "alex", payerId: "sam", cents: -1 },
		]);
	});

	test("two payers: each payer's rounding is its own; P2's $20.00 by five splits evenly", () => {
		expect(
			moves([item(1000, "p1", ["p1", "p2", "p3"], "a"), item(2000, "p2", ["p1", "p2", "p3", "p4", "p5"], "b")])
		).toEqual([{ memberId: "p1", payerId: "p1", cents: 1 }]);
	});

	test("one payer, two $10.00 items by three: rounded once over $20.00, so the payer's $6.67 is 1¢ less", () => {
		expect(moves([item(1000, "a", ["a", "b", "c"], "x"), item(1000, "a", ["a", "b", "c"], "y")])).toEqual([
			{ memberId: "a", payerId: "a", cents: -1 },
		]);
	});

	test("explains the shares it is given: stored shares that differ show the difference", () => {
		const items = [item(900, "alex", ["alex", "sam"])];
		const shares: Share[] = [
			{ memberId: "alex", paidCents: 900, owedCents: 450, owedTo: { alex: 450 } },
			{ memberId: "sam", paidCents: 0, owedCents: 450, owedTo: { alex: 450 } },
		];
		expect(explainRounding(items, shares)).toEqual([]);
		expect(explainRounding(items, [shares[0], { ...shares[1], owedTo: { alex: 449 } }])).toEqual([
			{ memberId: "sam", payerId: "alex", cents: -1 },
		]);
	});

	test("items computeShares would refuse have nothing to explain, rather than throwing", () => {
		const shares = computeShares([item(1000, "alex", ["alex", "sam"])]);
		expect(explainRounding([], shares)).toEqual([]);
		expect(explainRounding([item(1000, "alex", [])], shares)).toEqual([]);
		expect(explainRounding([item(1000, "alex", ["alex", "sam"]), item(500, "sam", [], "j")], shares)).toEqual([]);
		expect(explainRounding([item(1000, "alex", ["sam", "sam"])], shares)).toEqual([]);
		expect(explainRounding([item(0, "alex", ["alex", "sam"])], shares)).toEqual([]);
	});
});

describe("countsTowardsDebts", () => {
	const deleted = "2026-11-04T00:00:00Z";

	test("a bill counts until it is deleted", () => {
		expect(countsTowardsDebts({ kind: "expense", deletedAt: null, paymentStatus: null })).toBe(true);
		expect(countsTowardsDebts({ kind: "expense", deletedAt: deleted, paymentStatus: null })).toBe(false);
	});

	test("a payment counts only once confirmed", () => {
		const status = (paymentStatus: LedgerEntry["paymentStatus"]) =>
			countsTowardsDebts({ kind: "payment", deletedAt: null, paymentStatus });
		expect([status("pending"), status("declined"), status("undone"), status("confirmed")]).toEqual([
			false,
			false,
			false,
			true,
		]);
	});

	test("summarizeGroup counts exactly those: a deleted bill and pending, declined, undone payments drop out", () => {
		const people = [member("alex", "Alex"), member("sam", "Sam")];
		const lunch = bill(computeShares([item(4000, "alex", ["alex", "sam"])]));
		const taxi = { ...bill(computeShares([item(1000, "sam", ["alex", "sam"])])), deletedAt: deleted };
		const entries = [
			lunch,
			taxi,
			payment("sam", "alex", 500, "pending"),
			payment("sam", "alex", 700, "declined"),
			payment("sam", "alex", 900, "undone"),
			payment("sam", "alex", 1200, "confirmed"),
		];
		expect(entries.map(countsTowardsDebts)).toEqual([true, false, false, false, false, true]);
		// Sam owes half the $40.00 lunch, less the $12.00 confirmed.
		expect(summarizeGroup(entries, people)).toEqual({
			people: [
				{ memberId: "alex", balanceCents: 800, state: "owed" },
				{ memberId: "sam", balanceCents: -800, state: "owes" },
			],
			debts: [{ fromMemberId: "sam", toMemberId: "alex", amountCents: 800 }],
		});
	});
});

describe("summarizeGroup", () => {
	const people = [member("alex", "Alex"), member("sam", "Sam"), member("jo", "Jo")];
	const dinner = bill(computeShares([item(9000, "alex", ["alex", "sam", "jo"])]));
	const debtsOf = (entries: LedgerEntry[]) =>
		summarizeGroup(entries, people).debts.map((d) => `${d.fromMemberId}>${d.toMemberId}:${d.amountCents}`);

	test("the dinner alone", () => {
		expect(debtsOf([dinner])).toEqual(["jo>alex:3000", "sam>alex:3000"]);
	});

	test("a pending, declined or undone payment changes nothing", () => {
		for (const status of ["pending", "declined", "undone"] as const) {
			expect(debtsOf([dinner, payment("sam", "alex", 3000, status)])).toEqual(["jo>alex:3000", "sam>alex:3000"]);
		}
	});

	test("a confirmed payment counts, whole or in part", () => {
		expect(debtsOf([dinner, payment("sam", "alex", 3000, "confirmed")])).toEqual(["jo>alex:3000"]);
		expect(debtsOf([dinner, payment("sam", "alex", 2000, "confirmed")])).toEqual(["jo>alex:3000", "sam>alex:1000"]);
	});

	test("balances and states for the dinner and a confirmed payment", () => {
		const summary = summarizeGroup([dinner, payment("sam", "alex", 3000, "confirmed")], people);
		expect(summary.people).toEqual([
			{ memberId: "alex", balanceCents: 3000, state: "owed" },
			{ memberId: "jo", balanceCents: -3000, state: "owes" },
			{ memberId: "sam", balanceCents: 0, state: "settled" },
		]);
	});

	test("a payment can flip a debt to the other direction", () => {
		const entries = [dinner, payment("sam", "alex", 4000, "confirmed")];
		expect(debtsOf(entries)).toEqual(["alex>sam:1000", "jo>alex:3000"]);
	});

	test("deleted bills are skipped", () => {
		expect(summarizeGroup([{ ...dinner, deletedAt: "2026-11-04T00:00:00Z" }], people)).toEqual({
			people: [],
			debts: [],
		});
	});

	test("debts sort by debtor then creditor name, case-insensitively, then id", () => {
		const members = [member("1", "bea"), member("2", "Amy"), member("3", "amy"), member("4", "Cal")];
		const entry = bill(computeShares([item(300, "4", ["1", "2", "3"])]));
		const debts = summarizeGroup([entry], members).debts;
		expect(debts.map((d) => d.fromMemberId)).toEqual(["2", "3", "1"]);
		const people2 = summarizeGroup([entry], members).people;
		expect(people2.map((p) => p.memberId)).toEqual(["2", "3", "1", "4"]);
	});

	test("a member who is not in the group is a RangeError", () => {
		expect(() => summarizeGroup([bill(computeShares([item(100, "ghost", ["alex"])]))], people)).toThrow(RangeError);
	});

	test("accepts any iterable", () => {
		function* entries() {
			yield dinner;
		}
		expect(summarizeGroup(entries(), people).debts).toHaveLength(2);
	});
});

describe("validateEntry", () => {
	const members = [member("a"), member("b"), member("c")];
	const goodItems = [item(1000, "a", ["a", "b", "c"], "i1"), item(500, "b", ["c"], "i2")];
	const goodBill = (): EntryDraft => ({
		kind: "expense",
		description: "Dinner",
		amountCents: 1500,
		entryDate: "2026-11-04",
		notes: null,
		items: goodItems.map((x) => ({ ...x, splitAmong: [...x.splitAmong] })),
		shares: computeShares(goodItems),
	});
	const goodPayment = (): EntryDraft => ({
		kind: "payment",
		description: "",
		amountCents: 700,
		entryDate: "2026-11-04",
		notes: "cash",
		items: null,
		shares: computeShares([item(700, "a", ["b"])]),
	});
	const fieldsOf = (draft: EntryDraft) => validateEntry(draft, members).map((p) => p.field);

	test("lengths count code points, as Postgres char_length does", () => {
		const emoji = (n: number) => "\u{1F600}".repeat(n); // 2 UTF-16 units each
		const withItemDescription = (description: string) => {
			const draft = goodBill();
			draft.items![0].description = description;
			return draft;
		};
		expect(fieldsOf({ ...goodBill(), description: emoji(120) })).toEqual([]);
		expect(fieldsOf({ ...goodBill(), description: emoji(121) })).toEqual(["description"]);
		expect(fieldsOf({ ...goodBill(), notes: emoji(1000) })).toEqual([]);
		expect(fieldsOf({ ...goodBill(), notes: emoji(1001) })).toEqual(["notes"]);
		expect(fieldsOf(withItemDescription(emoji(60)))).toEqual([]);
		expect(fieldsOf(withItemDescription(emoji(61)))).toEqual(["items[0].description"]);
	});

	test("years 0001 to 0099 are real days; year 0 is not", () => {
		expect(fieldsOf({ ...goodBill(), entryDate: "0050-01-01" })).toEqual([]);
		expect(fieldsOf({ ...goodBill(), entryDate: "0001-12-31" })).toEqual([]);
		expect(fieldsOf({ ...goodBill(), entryDate: "0000-01-01" })).toEqual(["entryDate"]);
		expect(fieldsOf({ ...goodBill(), entryDate: "0050-02-29" })).toEqual(["entryDate"]);
	});

	test("accepts a good bill and a good payment", () => {
		expect(validateEntry(goodBill(), members)).toEqual([]);
		expect(validateEntry(goodPayment(), members)).toEqual([]);
	});

	test("accepts shares in any order and with zero parts spelled out", () => {
		const draft = goodBill();
		draft.shares = [...draft.shares].reverse().map((s) => ({ ...s, owedTo: { ...s.owedTo, a: s.owedTo.a ?? 0 } }));
		expect(validateEntry(draft, members)).toEqual([]);
	});

	test("a bill's description must be 1 to 120 characters", () => {
		for (const description of ["", "   ", "x".repeat(121)]) {
			expect(fieldsOf({ ...goodBill(), description })).toEqual(["description"]);
		}
	});

	test("the amount must be a whole number of cents from 1", () => {
		for (const amountCents of [0, -100, 10.5, Number.NaN, 1_000_000_000_001]) {
			expect(fieldsOf({ ...goodBill(), amountCents })).toContain("amountCents");
		}
	});

	test("the date must be YYYY-MM-DD and a real day", () => {
		expect(fieldsOf({ ...goodBill(), entryDate: "11/04/2026" })).toEqual(["entryDate"]);
		expect(fieldsOf({ ...goodBill(), entryDate: "2026-02-30" })).toEqual(["entryDate"]);
		expect(validateEntry({ ...goodBill(), entryDate: "2028-02-29" }, members)).toEqual([]);
	});

	test("notes are at most 1000 characters", () => {
		expect(fieldsOf({ ...goodBill(), notes: "x".repeat(1001) })).toEqual(["notes"]);
		expect(validateEntry({ ...goodBill(), notes: "x".repeat(1000) }, members)).toEqual([]);
	});

	test("a bill needs 1 to 50 items", () => {
		expect(fieldsOf({ ...goodBill(), items: null })).toEqual(["items"]);
		expect(fieldsOf({ ...goodBill(), items: [] })).toEqual(["items"]);
		const many = Array.from({ length: 51 }, (_, k) => item(10, "a", ["a"], `i${k}`));
		expect(fieldsOf({ ...goodBill(), amountCents: 510, items: many, shares: computeShares(many) })).toEqual(["items"]);
	});

	test("an item needs a whole positive amount", () => {
		const items = [item(1000.5, "a", ["a"]), item(499.5, "a", ["a"])];
		expect(fieldsOf({ ...goodBill(), items })).toEqual(["items[0].amountCents", "items[1].amountCents"]);
	});

	test("an item needs someone to split among, without repeats", () => {
		const nobody = [item(1000, "a", ["a", "b", "c"]), item(500, "b", [])];
		expect(fieldsOf({ ...goodBill(), items: nobody })).toEqual(["items[1].splitAmong"]);
		const twice = [item(1000, "a", ["a", "b", "c"]), item(500, "b", ["c", "c"])];
		expect(fieldsOf({ ...goodBill(), items: twice })).toEqual(["items[1].splitAmong"]);
	});

	test("an item's description is at most 60 characters", () => {
		const items = goodBill().items!;
		items[0].description = "x".repeat(61);
		expect(fieldsOf({ ...goodBill(), items })).toEqual(["items[0].description"]);
	});

	test("items must add up to the total", () => {
		expect(fieldsOf({ ...goodBill(), amountCents: 1600 })).toContain("items");
		const draft = { ...goodBill(), items: [item(1400, "a", ["a", "b", "c"])] };
		expect(fieldsOf(draft)).toEqual(["items"]);
	});

	test("a bill needs shares, one per person", () => {
		expect(fieldsOf({ ...goodBill(), shares: [] })).toEqual(["shares"]);
		const draft = goodBill();
		draft.shares = [...draft.shares, draft.shares[0]];
		expect(fieldsOf(draft)).toEqual(["shares"]);
	});

	test("shares must be whole and non-negative", () => {
		const fractional = goodBill();
		fractional.shares[0] = { ...fractional.shares[0], paidCents: 1000.5 };
		expect(fieldsOf(fractional)).toEqual(["shares[0]"]);
		const negative = goodBill();
		negative.shares[1] = { ...negative.shares[1], owedTo: { a: -1 } };
		expect(fieldsOf(negative)).toEqual(["shares[1]"]);
	});

	test("shares must add up to the amount, paid and owed", () => {
		const draft = goodBill();
		draft.shares[0] = { ...draft.shares[0], paidCents: draft.shares[0].paidCents + 1 };
		expect(fieldsOf(draft)).toEqual(["shares"]);
		const owed = goodBill();
		owed.shares[0] = { ...owed.shares[0], owedCents: owed.shares[0].owedCents + 1 };
		expect(fieldsOf(owed)).toEqual(["shares"]);
	});

	test("everyone must be in the group: share, payer, split and owedTo", () => {
		const outsider = (draft: EntryDraft) => fieldsOf(draft);
		const inShare = goodBill();
		inShare.shares[0] = { ...inShare.shares[0], memberId: "x" };
		expect(outsider(inShare)).toContain("members");
		const asPayer = goodBill();
		asPayer.items![1].paidBy = "x";
		expect(outsider(asPayer)).toContain("members");
		const inSplit = goodBill();
		inSplit.items![0].splitAmong = ["a", "b", "x"];
		expect(outsider(inSplit)).toContain("members");
		const inOwedTo = goodBill();
		inOwedTo.shares[0] = { ...inOwedTo.shares[0], owedTo: { x: inOwedTo.shares[0].owedCents } };
		expect(outsider(inOwedTo)).toContain("members");
	});

	test("shares that differ from computeShares(items) are refused", () => {
		const moved = goodBill();
		moved.shares = moved.shares.map((s) => ({ ...s }));
		moved.shares[0].owedCents += 1;
		moved.shares[1].owedCents -= 1;
		expect(fieldsOf(moved)).toEqual(["shares"]);
		expect(validateEntry(moved, members)[0].reason).toContain("don't match the items");
	});

	test("owedTo that differs from computeShares(items) is refused even when totals agree", () => {
		const draft = goodBill();
		const [first, second] = draft.shares.filter((s) => Object.keys(s.owedTo).length > 0);
		const swap = { ...first.owedTo };
		first.owedTo = { ...second.owedTo };
		second.owedTo = swap;
		expect(fieldsOf(draft)).toEqual(["shares"]);
	});

	test("one problem per failed rule", () => {
		const draft = { ...goodBill(), description: "", entryDate: "nope", notes: "x".repeat(2000) };
		expect(fieldsOf(draft)).toEqual(["description", "entryDate", "notes"]);
	});

	test("never throws on bad input", () => {
		const draft = { ...goodBill(), items: [item(Number.NaN, "a", [])], shares: [] };
		expect(() => validateEntry(draft, members)).not.toThrow();
		expect(validateEntry(draft, members).length).toBeGreaterThan(0);
	});

	describe("payments", () => {
		test("the two sides must be different", () => {
			const draft = goodPayment();
			draft.shares = [{ memberId: "a", paidCents: 700, owedCents: 700, owedTo: { a: 700 } }];
			expect(fieldsOf(draft)).toEqual(["shares"]);
			expect(validateEntry(draft, members)[0].reason).toContain("two different people");
		});

		test("both sides must be in the group", () => {
			const draft = goodPayment();
			draft.shares = computeShares([item(700, "a", ["x"])]);
			expect(fieldsOf(draft)).toEqual(["members"]);
		});

		test("the amount must be positive and whole", () => {
			for (const amountCents of [0, -700, 7.5]) {
				expect(fieldsOf({ ...goodPayment(), amountCents })).toContain("amountCents");
			}
		});

		test("the shares must be one payer, one receiver and the amount", () => {
			expect(fieldsOf({ ...goodPayment(), shares: [] })).toEqual(["shares"]);
			expect(fieldsOf({ ...goodPayment(), amountCents: 800 })).toEqual(["shares"]);
			const wrongOwedTo = goodPayment();
			wrongOwedTo.shares[0] = { ...wrongOwedTo.shares[0], owedTo: { c: 700 } };
			expect(fieldsOf(wrongOwedTo)).toContain("shares");
		});

		test("a payment has no items; a blank description is fine; the date is checked", () => {
			expect(fieldsOf({ ...goodPayment(), items: goodItems })).toEqual(["items"]);
			expect(validateEntry({ ...goodPayment(), items: [] }, members)).toEqual([]);
			expect(fieldsOf({ ...goodPayment(), description: "x".repeat(121) })).toEqual(["description"]);
			expect(fieldsOf({ ...goodPayment(), entryDate: "2026-13-01" })).toEqual(["entryDate"]);
		});
	});
});
