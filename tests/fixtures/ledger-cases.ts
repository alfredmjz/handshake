// Pinned bills that computeShares (src/lib/ledger.ts) and private.compute_shares (SQL) must both get
// right. Every number here is worked out by hand; nothing is computed by the code under test.
// `bun run gen:ledger-cases` renders this table into supabase/tests/ledger_cases.test.sql, and
// tests/lib/ledger-cases-sql.test.ts fails if that file is out of date. Only ever add cases.
//
// - People are named; the SQL side maps the n-th name in `members` to a fixed UUID.
// - `paid` and `owed` have one key per share, written in bill order: the order people first appear in
//   the items' splitAmong lists, then payers who are in no split. computeShares returns shares in that
//   order, and the SQL test checks it.
// - `balances` (paid − owed per share) and `payments` (suggested, in the order summarizeGroup finds
//   them) are for summarizeGroup; the SQL side doesn't use them.

export type LedgerCaseItem = { amountCents: number; paidBy: string; splitAmong: string[] };
export type LedgerCasePayment = { from: string; to: string; amountCents: number };

export type LedgerCase = {
	name: string;
	members: string[];
	items: LedgerCaseItem[];
	paid: Record<string, number>;
	owed: Record<string, number>;
	balances: Record<string, number>;
	payments: LedgerCasePayment[];
};

const P1 = "Person 1";
const P2 = "Person 2";
const P3 = "Person 3";
const P4 = "Person 4";
const P5 = "Person 5";
const FIVE = [P1, P2, P3, P4, P5];

export const LEDGER_CASES: LedgerCase[] = [
	{
		// 5000 × (5/5) = 5000 each over D = 5 → 1000 each; no cents left over.
		name: "Scenario A: 5000 split by Persons 1–5",
		members: FIVE,
		items: [{ amountCents: 5000, paidBy: P1, splitAmong: FIVE }],
		paid: { [P1]: 5000, [P2]: 0, [P3]: 0, [P4]: 0, [P5]: 0 },
		owed: { [P1]: 1000, [P2]: 1000, [P3]: 1000, [P4]: 1000, [P5]: 1000 },
		balances: { [P1]: 4000, [P2]: -1000, [P3]: -1000, [P4]: -1000, [P5]: -1000 },
		payments: [
			{ from: P2, to: P1, amountCents: 1000 },
			{ from: P3, to: P1, amountCents: 1000 },
			{ from: P4, to: P1, amountCents: 1000 },
			{ from: P5, to: P1, amountCents: 1000 },
		],
	},
	{
		// 333.33… rounds to 333 for all three (999); Sam, the payer, takes the missing cent.
		name: "$10 by Alex, Jo and Sam, Sam paid: Sam covers the cent",
		members: ["Alex", "Jo", "Sam"],
		items: [{ amountCents: 1000, paidBy: "Sam", splitAmong: ["Alex", "Jo", "Sam"] }],
		paid: { Alex: 0, Jo: 0, Sam: 1000 },
		owed: { Alex: 333, Jo: 333, Sam: 334 },
		balances: { Alex: -333, Jo: -333, Sam: 666 },
		payments: [
			{ from: "Alex", to: "Sam", amountCents: 333 },
			{ from: "Jo", to: "Sam", amountCents: 333 },
		],
	},
	{
		// 666.67 rounds to 667 for all three (2001); the extra cent comes off Sam's share.
		name: "$20 by Alex, Jo and Sam, Sam paid: the extra cent comes off Sam",
		members: ["Alex", "Jo", "Sam"],
		items: [{ amountCents: 2000, paidBy: "Sam", splitAmong: ["Alex", "Jo", "Sam"] }],
		paid: { Alex: 0, Jo: 0, Sam: 2000 },
		owed: { Alex: 667, Jo: 667, Sam: 666 },
		balances: { Alex: -667, Jo: -667, Sam: 1334 },
		payments: [
			{ from: "Alex", to: "Sam", amountCents: 667 },
			{ from: "Jo", to: "Sam", amountCents: 667 },
		],
	},
	{
		// D = 3. Person 1 and 2: (500 + 1000) / 3 = 500 exactly; Person 3: 500 + 800 = 1300. No rounding.
		name: "Scenario B: 500 and 1000 by Persons 1–3, 800 by Person 3",
		members: [P1, P2, P3],
		items: [
			{ amountCents: 500, paidBy: P1, splitAmong: [P1, P2, P3] },
			{ amountCents: 1000, paidBy: P1, splitAmong: [P1, P2, P3] },
			{ amountCents: 800, paidBy: P1, splitAmong: [P3] },
		],
		paid: { [P1]: 2300, [P2]: 0, [P3]: 0 },
		owed: { [P1]: 500, [P2]: 500, [P3]: 1300 },
		balances: { [P1]: 1800, [P2]: -500, [P3]: -1300 },
		payments: [
			{ from: P3, to: P1, amountCents: 1300 },
			{ from: P2, to: P1, amountCents: 500 },
		],
	},
	{
		// D = 6. Person 1: 500 exactly; Persons 2 and 3: 500 + 400 = 900 exactly.
		name: "Scenario C: 500 and 1000 by Persons 1–3, 800 by Persons 2 and 3",
		members: [P1, P2, P3],
		items: [
			{ amountCents: 500, paidBy: P1, splitAmong: [P1, P2, P3] },
			{ amountCents: 1000, paidBy: P1, splitAmong: [P1, P2, P3] },
			{ amountCents: 800, paidBy: P1, splitAmong: [P2, P3] },
		],
		paid: { [P1]: 2300, [P2]: 0, [P3]: 0 },
		owed: { [P1]: 500, [P2]: 900, [P3]: 900 },
		balances: { [P1]: 1800, [P2]: -900, [P3]: -900 },
		payments: [
			{ from: P2, to: P1, amountCents: 900 },
			{ from: P3, to: P1, amountCents: 900 },
		],
	},
	{
		// (6000 + 4000) / 5 = 2000 each exactly. Debtors tie at −2000 and go by name; after Person 3 pays
		// Person 1, both creditors are at +2000 and Person 1 comes first by name.
		name: "Several payers, even: 6000 paid by Person 1 and 4000 by Person 2, both split by all 5",
		members: FIVE,
		items: [
			{ amountCents: 6000, paidBy: P1, splitAmong: FIVE },
			{ amountCents: 4000, paidBy: P2, splitAmong: FIVE },
		],
		paid: { [P1]: 6000, [P2]: 4000, [P3]: 0, [P4]: 0, [P5]: 0 },
		owed: { [P1]: 2000, [P2]: 2000, [P3]: 2000, [P4]: 2000, [P5]: 2000 },
		balances: { [P1]: 4000, [P2]: 2000, [P3]: -2000, [P4]: -2000, [P5]: -2000 },
		payments: [
			{ from: P3, to: P1, amountCents: 2000 },
			{ from: P4, to: P1, amountCents: 2000 },
			{ from: P5, to: P2, amountCents: 2000 },
		],
	},
	{
		// D = 15. Persons 1–3: 333.33 + 400 = 733.33 → 733; Persons 4–5: 400 exactly. Σ = 2999 of 3000, so
		// the biggest payer (Person 2, 2000) takes the cent: 734.
		name: "Several payers, with a cent: the biggest payer covers it",
		members: FIVE,
		items: [
			{ amountCents: 1000, paidBy: P1, splitAmong: [P1, P2, P3] },
			{ amountCents: 2000, paidBy: P2, splitAmong: FIVE },
		],
		paid: { [P1]: 1000, [P2]: 2000, [P3]: 0, [P4]: 0, [P5]: 0 },
		owed: { [P1]: 733, [P2]: 734, [P3]: 733, [P4]: 400, [P5]: 400 },
		balances: { [P1]: 267, [P2]: 1266, [P3]: -733, [P4]: -400, [P5]: -400 },
		payments: [
			{ from: P3, to: P2, amountCents: 733 },
			{ from: P4, to: P2, amountCents: 400 },
			{ from: P5, to: P1, amountCents: 267 },
			{ from: P5, to: P2, amountCents: 133 },
		],
	},
	{
		// 666.67 → 667 for all three (2001). Sam owes nothing to take the cent off, so it comes off the share
		// rounded up most; all three tie (667 − 666.67), and Alex is first on the bill.
		name: "Payer not sharing: Sam pays 2000 split by Alex, Jo and Kim",
		members: ["Alex", "Jo", "Kim", "Sam"],
		items: [{ amountCents: 2000, paidBy: "Sam", splitAmong: ["Alex", "Jo", "Kim"] }],
		paid: { Alex: 0, Jo: 0, Kim: 0, Sam: 2000 },
		owed: { Alex: 666, Jo: 667, Kim: 667, Sam: 0 },
		balances: { Alex: -666, Jo: -667, Kim: -667, Sam: 2000 },
		payments: [
			{ from: "Jo", to: "Sam", amountCents: 667 },
			{ from: "Kim", to: "Sam", amountCents: 667 },
			{ from: "Alex", to: "Sam", amountCents: 666 },
		],
	},
	{
		// 333.33 → 333 for all three (999); Sam, the payer, owes the missing cent without being in the split.
		name: "Payer not sharing: Sam pays 1000 split by Alex, Jo and Kim, and owes 1",
		members: ["Alex", "Jo", "Kim", "Sam"],
		items: [{ amountCents: 1000, paidBy: "Sam", splitAmong: ["Alex", "Jo", "Kim"] }],
		paid: { Alex: 0, Jo: 0, Kim: 0, Sam: 1000 },
		owed: { Alex: 333, Jo: 333, Kim: 333, Sam: 1 },
		balances: { Alex: -333, Jo: -333, Kim: -333, Sam: 999 },
		payments: [
			{ from: "Alex", to: "Sam", amountCents: 333 },
			{ from: "Jo", to: "Sam", amountCents: 333 },
			{ from: "Kim", to: "Sam", amountCents: 333 },
		],
	},
	{
		// Rounded once per person: 2000 / 3 = 666.67 → 667 each (2001), not 333 + 333 per item. Sam gives
		// back the extra cent.
		name: "Two items of 1000, each split by Alex, Jo and Sam, Sam paid both",
		members: ["Alex", "Jo", "Sam"],
		items: [
			{ amountCents: 1000, paidBy: "Sam", splitAmong: ["Alex", "Jo", "Sam"] },
			{ amountCents: 1000, paidBy: "Sam", splitAmong: ["Alex", "Jo", "Sam"] },
		],
		paid: { Alex: 0, Jo: 0, Sam: 2000 },
		owed: { Alex: 667, Jo: 667, Sam: 666 },
		balances: { Alex: -667, Jo: -667, Sam: 1334 },
		payments: [
			{ from: "Alex", to: "Sam", amountCents: 667 },
			{ from: "Jo", to: "Sam", amountCents: 667 },
		],
	},
	{
		// A payment is a one-item bill: the person paying back paid it, the person receiving owes it. Alex
		// is in the split, so Alex comes first; Sam is a payer in no split, so last.
		name: "A payment: Sam pays Alex 3000",
		members: ["Alex", "Sam"],
		items: [{ amountCents: 3000, paidBy: "Sam", splitAmong: ["Alex"] }],
		paid: { Alex: 0, Sam: 3000 },
		owed: { Alex: 3000, Sam: 0 },
		balances: { Alex: -3000, Sam: 3000 },
		payments: [{ from: "Alex", to: "Sam", amountCents: 3000 }],
	},
	{
		// 0.33 rounds to 0 for all three (0); Alex, the payer, owes the cent. Jo and Sam keep 0/0 shares.
		name: "One cent split three ways: the payer owes it, the others get 0/0 shares",
		members: ["Alex", "Jo", "Sam"],
		items: [{ amountCents: 1, paidBy: "Alex", splitAmong: ["Alex", "Jo", "Sam"] }],
		paid: { Alex: 1, Jo: 0, Sam: 0 },
		owed: { Alex: 1, Jo: 0, Sam: 0 },
		balances: { Alex: 0, Jo: 0, Sam: 0 },
		payments: [],
	},
	{
		// 250.5 rounds half up to 251 for all four (1004 of 1002). Sam owes nothing, so two cents come off,
		// one each: every share tied (251 − 250.5), so the first two on the bill, Alex and Jo.
		name: "Payer not sharing, two cents over: they come off the first two on the bill",
		members: ["Alex", "Jo", "Kim", "Lee", "Sam"],
		items: [{ amountCents: 1002, paidBy: "Sam", splitAmong: ["Alex", "Jo", "Kim", "Lee"] }],
		paid: { Alex: 0, Jo: 0, Kim: 0, Lee: 0, Sam: 1002 },
		owed: { Alex: 250, Jo: 250, Kim: 251, Lee: 251, Sam: 0 },
		balances: { Alex: -250, Jo: -250, Kim: -251, Lee: -251, Sam: 1002 },
		payments: [
			{ from: "Kim", to: "Sam", amountCents: 251 },
			{ from: "Lee", to: "Sam", amountCents: 251 },
			{ from: "Alex", to: "Sam", amountCents: 250 },
			{ from: "Jo", to: "Sam", amountCents: 250 },
		],
	},
	{
		// D = 6. Exact: Alex and Jo 666.67 → 667, Kim 666.67 + 1.5 = 668.17 → 668, Lee 1.5 → 2. Σ = 2004 of
		// 2003 and Sam owes nothing, so one cent comes off the share rounded up most: Lee (+0.5 beats +0.33).
		name: "Payer not sharing: the extra cent comes off the share rounded up most",
		members: ["Alex", "Jo", "Kim", "Lee", "Sam"],
		items: [
			{ amountCents: 2000, paidBy: "Sam", splitAmong: ["Alex", "Jo", "Kim"] },
			{ amountCents: 3, paidBy: "Sam", splitAmong: ["Kim", "Lee"] },
		],
		paid: { Alex: 0, Jo: 0, Kim: 0, Lee: 0, Sam: 2003 },
		owed: { Alex: 667, Jo: 667, Kim: 668, Lee: 1, Sam: 0 },
		balances: { Alex: -667, Jo: -667, Kim: -668, Lee: -1, Sam: 2003 },
		payments: [
			{ from: "Kim", to: "Sam", amountCents: 668 },
			{ from: "Alex", to: "Sam", amountCents: 667 },
			{ from: "Jo", to: "Sam", amountCents: 667 },
			{ from: "Lee", to: "Sam", amountCents: 1 },
		],
	},
	{
		// 2000 / 3 = 666.67 → 667 each (2001). Jo and Sam both paid 1000; Jo paid the earlier item, so Jo
		// gives back the extra cent.
		name: "Payers tie: the one who paid the earliest item covers the cent",
		members: ["Alex", "Jo", "Sam"],
		items: [
			{ amountCents: 1000, paidBy: "Jo", splitAmong: ["Alex", "Jo", "Sam"] },
			{ amountCents: 1000, paidBy: "Sam", splitAmong: ["Alex", "Jo", "Sam"] },
		],
		paid: { Alex: 0, Jo: 1000, Sam: 1000 },
		owed: { Alex: 667, Jo: 666, Sam: 667 },
		balances: { Alex: -667, Jo: 334, Sam: 333 },
		payments: [
			{ from: "Alex", to: "Jo", amountCents: 334 },
			{ from: "Alex", to: "Sam", amountCents: 333 },
		],
	},
];
