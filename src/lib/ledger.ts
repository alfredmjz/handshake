// The money rules, shared by the app and the API function (which loads this file at runtime, so it has
// no imports). Rounding, the entry checks and debts live here once; docs/architecture.md §9.3 has the
// exact algorithm and tests/fixtures/ledger-cases.ts the pinned numbers.

export type Item = { id: string; description?: string; amountCents: number; paidBy: string; splitAmong: string[] };

// owedTo: what this member owes each payer (payer member id -> cents), non-zero parts only. A payer's own
// part is included and nets to nothing in debts.
export type Share = { memberId: string; paidCents: number; owedCents: number; owedTo: Record<string, number> };

export type LedgerMember = { id: string; displayName: string; hasLogin: boolean };

export type PaymentStatus = "pending" | "confirmed" | "declined" | "undone";

export type LedgerEntry = {
	kind: "expense" | "payment";
	deletedAt: string | null;
	paymentStatus: PaymentStatus | null;
	shares: Share[];
};

export type EntryDraft = {
	kind: "expense" | "payment";
	description: string;
	amountCents: number;
	entryDate: string;
	notes: string | null;
	items: Item[] | null;
	shares: Share[];
};

export type EntryProblem = { field: string; reason: string };

// fromMemberId owes toMemberId.
export type Debt = { fromMemberId: string; toMemberId: string; amountCents: number };

export type PersonSummary = { memberId: string; balanceCents: number; state: "owes" | "owed" | "settled" };

export type GroupSummary = { people: PersonSummary[]; debts: Debt[] };

const MAX_CENTS = 1_000_000_000_000;
const MAX_ITEMS = 50;

// ---------------------------------------------------------------------------
// computeShares
// ---------------------------------------------------------------------------

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
const lcm = (a: bigint, b: bigint): bigint => (a / gcd(a, b)) * b;

function assertWellFormed(items: Item[]) {
	if (!Array.isArray(items) || items.length === 0) throw new RangeError("computeShares needs at least one item");
	for (const item of items) {
		if (!Number.isSafeInteger(item.amountCents) || item.amountCents < 1) {
			throw new RangeError("Each item needs a whole, positive amount of cents");
		}
		if (!Array.isArray(item.splitAmong) || item.splitAmong.length === 0) {
			throw new RangeError("Each item needs someone to split it");
		}
		if (new Set(item.splitAmong).size !== item.splitAmong.length) {
			throw new RangeError("Someone appears twice in an item's split");
		}
	}
}

// People as they first appear in the items' splits, then payers who are in no split.
function billOrder(items: Item[]): string[] {
	const order: string[] = [];
	const seen = new Set<string>();
	const add = (id: string) => {
		if (seen.has(id)) return;
		seen.add(id);
		order.push(id);
	};
	for (const item of items) item.splitAmong.forEach(add);
	for (const item of items) add(item.paidBy);
	return order;
}

export function computeShares(items: Item[]): Share[] {
	assertWellFormed(items);
	const people = billOrder(items);
	const index = new Map(people.map((id, k) => [id, k]));
	const paid = people.map(() => 0n);
	const owed = people.map(() => 0n);
	const owedTo: Record<string, number>[] = people.map(() => ({}));

	for (const item of items) paid[index.get(item.paidBy)!] += BigInt(item.amountCents);

	const payers = people.filter((id) => items.some((item) => item.paidBy === id));
	for (const payer of payers) {
		const p = index.get(payer)!;
		const theirs = items.filter((item) => item.paidBy === payer);
		const d = theirs.reduce((acc, item) => lcm(acc, BigInt(item.splitAmong.length)), 1n);

		const num = people.map(() => 0n);
		for (const item of theirs) {
			const each = BigInt(item.amountCents) * (d / BigInt(item.splitAmong.length));
			for (const id of item.splitAmong) num[index.get(id)!] += each;
		}
		const part = num.map((n) => (2n * n + d) / (2n * d));
		const diff = theirs.reduce((acc, item) => acc + BigInt(item.amountCents), 0n) - part.reduce((a, b) => a + b, 0n);

		if (part[p] + diff >= 0n) {
			part[p] += diff;
		} else {
			// The payer can't owe themselves less than nothing: the cents come off the parts rounded up most.
			let short = -(part[p] + diff);
			part[p] = 0n;
			const byExcess = people
				.map((_, k) => k)
				.filter((k) => k !== p)
				.sort((a, b) => {
					const ea = part[a] * d - num[a];
					const eb = part[b] * d - num[b];
					return ea === eb ? a - b : eb > ea ? 1 : -1;
				});
			for (const k of byExcess) {
				if (short === 0n) break;
				part[k] -= 1n;
				short -= 1n;
			}
		}

		part.forEach((cents, k) => {
			if (cents <= 0n) return;
			owed[k] += cents;
			owedTo[k][payer] = Number(cents);
		});
	}

	return people.map((memberId, k) => ({
		memberId,
		paidCents: Number(paid[k]),
		owedCents: Number(owed[k]),
		owedTo: owedTo[k],
	}));
}

// ---------------------------------------------------------------------------
// validateEntry
// ---------------------------------------------------------------------------

const isCents = (value: unknown, min: number): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= min && value <= MAX_CENTS;

function isRealDate(value: unknown): boolean {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function nonZero(owedTo: Record<string, number>): Record<string, number> {
	return Object.fromEntries(Object.entries(owedTo).filter(([, cents]) => cents !== 0));
}

function sameShares(a: Share[], b: Share[]): boolean {
	if (a.length !== b.length) return false;
	const key = (share: Share) =>
		JSON.stringify([
			share.memberId,
			share.paidCents,
			share.owedCents,
			Object.entries(nonZero(share.owedTo)).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
		]);
	const left = a.map(key).sort();
	const right = b.map(key).sort();
	return left.every((value, i) => value === right[i]);
}

// Every HS422 rule of the spec's "Entry checks on the server", as the server applies them to a bill
// (entry.create) or a payment (payment.record, whose shares are worked out from its two sides). Returns
// [] when the entry would be accepted; never throws.
export function validateEntry(entry: EntryDraft, members: LedgerMember[]): EntryProblem[] {
	const problems: EntryProblem[] = [];
	const problem = (field: string, reason: string) => problems.push({ field, reason });
	const draft = (isRecord(entry) ? entry : {}) as Partial<Record<keyof EntryDraft, unknown>>;
	const inGroup = new Set(members.map((member) => member.id));
	const isPayment = draft.kind === "payment";

	if (draft.kind !== "expense" && draft.kind !== "payment") problem("kind", "An entry is a bill or a payment");

	if (typeof draft.description !== "string") {
		problem("description", "The description must be text");
	} else {
		const length = draft.description.trim().length;
		if (isPayment ? length > 120 : length < 1 || length > 120) {
			problem("description", "The description must be 1 to 120 characters");
		}
	}
	const amountOk = isCents(draft.amountCents, 1);
	if (!amountOk) problem("amountCents", "The amount must be a whole number of cents from 1 to 10^12");
	if (!isRealDate(draft.entryDate)) problem("entryDate", "The date must be a real day, YYYY-MM-DD");
	if (draft.notes !== null && (typeof draft.notes !== "string" || draft.notes.length > 1000)) {
		problem("notes", "Notes must be text of at most 1000 characters");
	}

	// Shares: one per person, whole cents, adding up to the amount both ways, each split by payer.
	const shares = Array.isArray(draft.shares) ? (draft.shares as unknown[]) : null;
	const sharesOk =
		shares !== null &&
		shares.length > 0 &&
		shares.every(
			(share) =>
				isRecord(share) &&
				typeof share.memberId === "string" &&
				isCents(share.paidCents, 0) &&
				isCents(share.owedCents, 0) &&
				isRecord(share.owedTo) &&
				Object.values(share.owedTo).every((cents) => isCents(cents, 0))
		);
	if (!sharesOk) {
		problem("shares", "Each share needs whole, non-negative paidCents and owedCents, and owedTo by payer");
	}
	const typedShares = sharesOk ? (shares as Share[]) : [];
	if (sharesOk) {
		if (new Set(typedShares.map((share) => share.memberId)).size !== typedShares.length) {
			problem("shares", "Someone appears twice in the shares");
		}
		const sum = (pick: (share: Share) => number) => typedShares.reduce((total, share) => total + pick(share), 0);
		if (amountOk && (sum((s) => s.paidCents) !== draft.amountCents || sum((s) => s.owedCents) !== draft.amountCents)) {
			problem("shares", "The shares must add up to the amount");
		}
		for (const share of typedShares) {
			const parts = Object.values(share.owedTo).reduce((total, cents) => total + cents, 0);
			if (parts !== share.owedCents) problem("shares", "Each share's owedTo must add up to what it owes");
		}
	}

	let expected: Share[] | null = null;
	const named: unknown[] = typedShares.flatMap((share) => [share.memberId, ...Object.keys(share.owedTo)]);

	if (isPayment) {
		if (draft.items !== null) problem("items", "A payment has no items");
		if (sharesOk && amountOk) {
			const from = typedShares.find((share) => share.paidCents > 0);
			const to = typedShares.find((share) => share.owedCents > 0);
			if (typedShares.length !== 2 || !from || !to) {
				problem("shares", "A payment is between two people");
			} else if (from.memberId === to.memberId) {
				problem("shares", "A payment is between two different people");
			} else {
				expected = computeShares([
					{ id: "payment", amountCents: draft.amountCents as number, paidBy: from.memberId, splitAmong: [to.memberId] },
				]);
			}
		}
	} else {
		const items = Array.isArray(draft.items) ? (draft.items as unknown[]) : null;
		if (items === null || items.length < 1 || items.length > MAX_ITEMS) {
			problem("items", `A bill needs 1 to ${MAX_ITEMS} items`);
		}
		let itemsOk = items !== null && items.length >= 1 && items.length <= MAX_ITEMS;
		for (const raw of items ?? []) {
			const item = isRecord(raw) ? raw : {};
			if (!isCents(item.amountCents, 1)) {
				problem("items", "Each item needs a whole amount of cents from 1 to 10^12");
				itemsOk = false;
			}
			if (item.description !== undefined && (typeof item.description !== "string" || item.description.length > 60)) {
				problem("items", "An item's description must be text of at most 60 characters");
			}
			if (typeof item.paidBy !== "string") {
				problem("items", "Each item needs someone who paid it");
				itemsOk = false;
			}
			const split = Array.isArray(item.splitAmong) ? (item.splitAmong as unknown[]) : [];
			if (split.length === 0 || !split.every((id) => typeof id === "string")) {
				problem("items", "Each item needs someone to split it");
				itemsOk = false;
			} else if (new Set(split).size !== split.length) {
				problem("items", "Someone appears twice in an item's split");
				itemsOk = false;
			}
			named.push(item.paidBy, ...split);
		}
		if (itemsOk && amountOk) {
			const typedItems = items as Item[];
			if (typedItems.reduce((total, item) => total + item.amountCents, 0) !== draft.amountCents) {
				problem("items", "The items must add up to the amount");
			}
			expected = computeShares(typedItems);
		}
	}

	if (named.some((id) => typeof id !== "string" || !inGroup.has(id))) {
		problem(
			"members",
			isPayment ? "Both sides of a payment must be in this group" : "Everyone in a bill must be in this group"
		);
	}
	if (expected && sharesOk && !sameShares(expected, typedShares)) {
		problem("shares", "The shares don't match the items");
	}
	return problems;
}

// ---------------------------------------------------------------------------
// summarizeGroup
// ---------------------------------------------------------------------------

function entryCounts(entry: LedgerEntry): boolean {
	return entry.kind === "expense" ? entry.deletedAt === null : entry.paymentStatus === "confirmed";
}

// Balances and pairwise debts over the bills that aren't deleted and the payments that count. Nothing
// is simplified across the group: A's debt to B is what A owes B minus what B owes A (spec "Debts").
export function summarizeGroup(entries: Iterable<LedgerEntry>, members: LedgerMember[]): GroupSummary {
	const byId = new Map(members.map((member) => [member.id, member]));
	const known = (id: string) => {
		if (!byId.has(id)) throw new RangeError(`summarizeGroup: ${id} is not in members`);
	};

	const balance = new Map<string, number>();
	// owes.get(a).get(b): what a owes b, before netting.
	const owes = new Map<string, Map<string, number>>();

	for (const entry of entries) {
		for (const share of entry.shares) {
			known(share.memberId);
			for (const payer of Object.keys(share.owedTo)) known(payer);
		}
		if (!entryCounts(entry)) continue;
		for (const share of entry.shares) {
			balance.set(share.memberId, (balance.get(share.memberId) ?? 0) + share.paidCents - share.owedCents);
			for (const [payer, cents] of Object.entries(share.owedTo)) {
				if (payer === share.memberId || cents === 0) continue;
				const row = owes.get(share.memberId) ?? new Map<string, number>();
				row.set(payer, (row.get(payer) ?? 0) + cents);
				owes.set(share.memberId, row);
			}
		}
	}

	const byName = (a: string, b: string) => {
		const x = byId.get(a)!;
		const y = byId.get(b)!;
		return (
			x.displayName.localeCompare(y.displayName, undefined, { sensitivity: "base" }) ||
			(x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
		);
	};

	const debts: Debt[] = [];
	const ids = [...new Set([...owes.keys(), ...[...owes.values()].flatMap((row) => [...row.keys()])])];
	for (const [i, a] of ids.entries()) {
		for (const b of ids.slice(i + 1)) {
			const net = (owes.get(a)?.get(b) ?? 0) - (owes.get(b)?.get(a) ?? 0);
			if (net > 0) debts.push({ fromMemberId: a, toMemberId: b, amountCents: net });
			if (net < 0) debts.push({ fromMemberId: b, toMemberId: a, amountCents: -net });
		}
	}
	debts.sort((x, y) => byName(x.fromMemberId, y.fromMemberId) || byName(x.toMemberId, y.toMemberId));

	const people = [...balance.keys()].sort(byName).map((memberId): PersonSummary => {
		const balanceCents = balance.get(memberId)!;
		return { memberId, balanceCents, state: balanceCents > 0 ? "owed" : balanceCents < 0 ? "owes" : "settled" };
	});

	return { people, debts };
}
