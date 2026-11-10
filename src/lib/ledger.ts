export type Item = { id: string; description?: string; amountCents: number; paidBy: string; splitAmong: string[] };
export type Share = { memberId: string; paidCents: number; owedCents: number; owedTo: Record<string, number> };
export type LedgerMember = { id: string; displayName: string; hasLogin: boolean };
export type LedgerEntry = {
	kind: "expense" | "payment";
	deletedAt: string | null;
	paymentStatus: "pending" | "confirmed" | "declined" | "undone" | null;
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
export type Debt = { fromMemberId: string; toMemberId: string; amountCents: number };
export type PersonSummary = { memberId: string; balanceCents: number; state: "owes" | "owed" | "settled" };
export type GroupSummary = { people: PersonSummary[]; debts: Debt[] };

const MAX_CENTS = 1_000_000_000_000;

function gcd(a: bigint, b: bigint): bigint {
	return b === 0n ? a : gcd(b, a % b);
}

function isCents(value: unknown, min: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= MAX_CENTS;
}

function hasRepeats(ids: string[]): boolean {
	return new Set(ids).size !== ids.length;
}

export function computeShares(items: Item[]): Share[] {
	if (items.length === 0) throw new RangeError("A bill needs at least one item");
	for (const item of items) {
		if (!Number.isSafeInteger(item.amountCents) || item.amountCents <= 0) {
			throw new RangeError("Item amounts must be whole, positive cents");
		}
		if (item.splitAmong.length === 0) throw new RangeError("Each item needs someone to split it");
		if (hasRepeats(item.splitAmong)) throw new RangeError("Someone appears twice in an item's split");
	}

	// Bill order: people as they first appear in the splits, then payers who are in no split.
	const order: string[] = [];
	const position = new Map<string, number>();
	const add = (id: string) => {
		if (!position.has(id)) {
			position.set(id, order.length);
			order.push(id);
		}
	};
	for (const item of items) item.splitAmong.forEach(add);
	for (const item of items) add(item.paidBy);

	const paid = order.map(() => 0);
	const owed = order.map(() => 0);
	const owedTo = order.map((): Record<string, number> => ({}));
	for (const item of items) paid[position.get(item.paidBy)!] += item.amountCents;

	for (const payer of new Set(items.map((item) => item.paidBy))) {
		const payerItems = items.filter((item) => item.paidBy === payer);
		let d = 1n;
		for (const item of payerItems) {
			const n = BigInt(item.splitAmong.length);
			d = (d / gcd(d, n)) * n;
		}

		const num = order.map(() => 0n);
		let total = 0n;
		for (const item of payerItems) {
			const each = BigInt(item.amountCents) * (d / BigInt(item.splitAmong.length));
			for (const who of item.splitAmong) num[position.get(who)!] += each;
			total += BigInt(item.amountCents);
		}

		const part = num.map((n) => (2n * n + d) / (2n * d));
		const p = position.get(payer)!;
		const diff = total - part.reduce((sum, x) => sum + x, 0n);
		if (part[p] + diff >= 0n) {
			part[p] += diff;
		} else {
			const short = -(part[p] + diff);
			part[p] = 0n;
			const excess = (k: number) => part[k] * d - num[k];
			const candidates = order
				.map((_, k) => k)
				.filter((k) => k !== p)
				.sort((a, b) => {
					const ea = excess(a);
					const eb = excess(b);
					return ea > eb ? -1 : ea < eb ? 1 : a - b;
				})
				.slice(0, Number(short));
			for (const k of candidates) part[k] -= 1n;
		}

		part.forEach((cents, k) => {
			if (cents > 0n) {
				owed[k] += Number(cents);
				owedTo[k][payer] = Number(cents);
			}
		});
	}

	return order.map((memberId, k) => ({ memberId, paidCents: paid[k], owedCents: owed[k], owedTo: owedTo[k] }));
}

// Order-independent, like the server's EXCEPT comparison; zero parts don't count.
function sameShares(a: Share[], b: Share[]): boolean {
	if (a.length !== b.length) return false;
	const nonZero = (owedTo: Record<string, number>) =>
		Object.entries(owedTo)
			.filter(([, cents]) => cents > 0)
			.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
	const byMember = new Map(b.map((share) => [share.memberId, share]));
	return a.every((share) => {
		const other = byMember.get(share.memberId);
		return (
			other !== undefined &&
			share.paidCents === other.paidCents &&
			share.owedCents === other.owedCents &&
			JSON.stringify(nonZero(share.owedTo)) === JSON.stringify(nonZero(other.owedTo))
		);
	});
}

function isRealDate(text: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	if (!match) return false;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	// Postgres has no year 0; setUTCFullYear keeps years 1-99 as written (Date.UTC maps them to 1900s).
	if (year < 1) return false;
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Postgres char_length counts code points, not UTF-16 units.
function charLength(text: string): number {
	return [...text].length;
}

export function validateEntry(entry: EntryDraft, members: LedgerMember[]): EntryProblem[] {
	const problems: EntryProblem[] = [];
	const problem = (field: string, reason: string) => problems.push({ field, reason });
	const inGroup = new Set(members.map((member) => member.id));
	const isPayment = entry.kind === "payment";

	if (entry.kind !== "expense" && entry.kind !== "payment") problem("kind", "An entry is a bill or a payment");

	const length = charLength(entry.description.trim());
	if (isPayment && length > 120) problem("description", "The description must be at most 120 characters");
	if (!isPayment && (length < 1 || length > 120)) problem("description", "The description must be 1 to 120 characters");

	const amountOk = isCents(entry.amountCents, 1);
	if (!amountOk) problem("amountCents", "The amount must be a whole number of cents from 1 to 10^12");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.entryDate)) problem("entryDate", "The date must be YYYY-MM-DD");
	else if (!isRealDate(entry.entryDate)) problem("entryDate", "The date must be a real day");
	if (entry.notes !== null && (typeof entry.notes !== "string" || charLength(entry.notes) > 1000)) {
		problem("notes", "Notes must be text of at most 1000 characters");
	}

	const named: string[] = [];
	let sharesOk = true;
	let itemsOk = true;

	for (const [i, share] of entry.shares.entries()) {
		named.push(share.memberId, ...Object.keys(share.owedTo));
		const wholeParts = Object.values(share.owedTo).every((cents) => isCents(cents, 0));
		if (!isCents(share.paidCents, 0) || !isCents(share.owedCents, 0) || !wholeParts) {
			problem(`shares[${i}]`, "Each share needs whole, non-negative paidCents and owedCents, and owedTo by payer");
			sharesOk = false;
		}
	}

	if (isPayment) {
		if (entry.items !== null && entry.items.length > 0) problem("items", "A payment has no items");
		if (sharesOk) {
			const payers = entry.shares.filter((share) => share.paidCents > 0);
			const receivers = entry.shares.filter((share) => share.owedCents > 0);
			if (payers.length !== 1 || receivers.length !== 1) {
				problem("shares", "A payment has one payer and one receiver");
			} else if (payers[0].memberId === receivers[0].memberId) {
				problem("shares", "A payment is between two different people");
			} else if (amountOk) {
				const expected = computeShares([
					{
						id: "payment",
						amountCents: entry.amountCents,
						paidBy: payers[0].memberId,
						splitAmong: [receivers[0].memberId],
					},
				]);
				if (!sameShares(entry.shares, expected)) problem("shares", "The shares don't match the payment");
			}
		}
		if (named.some((id) => !inGroup.has(id))) problem("members", "Both sides of a payment must be in this group");
		return problems;
	}

	if (entry.shares.length === 0) {
		problem("shares", "A bill needs its shares");
		sharesOk = false;
	}
	if (hasRepeats(entry.shares.map((share) => share.memberId))) {
		problem("shares", "Someone appears twice in the shares");
		sharesOk = false;
	}
	if (sharesOk && amountOk) {
		const sum = (pick: (share: Share) => number) => entry.shares.reduce((total, share) => total + pick(share), 0);
		if (
			sum((share) => share.paidCents) !== entry.amountCents ||
			sum((share) => share.owedCents) !== entry.amountCents
		) {
			problem("shares", "The shares must add up to the amount");
			sharesOk = false;
		}
	}

	const items = entry.items;
	if (items === null || items.length < 1 || items.length > 50) {
		problem("items", "A bill needs 1 to 50 items");
		itemsOk = false;
	} else {
		for (const [i, item] of items.entries()) {
			named.push(item.paidBy, ...item.splitAmong);
			if (!isCents(item.amountCents, 1)) {
				problem(`items[${i}].amountCents`, "Each item needs a whole amount of cents from 1 to 10^12");
				itemsOk = false;
			}
			if (item.description !== undefined && charLength(item.description) > 60) {
				problem(`items[${i}].description`, "An item's description must be at most 60 characters");
				itemsOk = false;
			}
			if (item.splitAmong.length === 0) {
				problem(`items[${i}].splitAmong`, "Each item needs someone to split it");
				itemsOk = false;
			} else if (hasRepeats(item.splitAmong)) {
				problem(`items[${i}].splitAmong`, "Someone appears twice in an item's split");
				itemsOk = false;
			}
		}
		if (itemsOk && amountOk && items.reduce((total, item) => total + item.amountCents, 0) !== entry.amountCents) {
			problem("items", "The items must add up to the amount");
			itemsOk = false;
		}
	}

	if (named.some((id) => !inGroup.has(id))) problem("members", "Everyone in a bill must be in this group");

	if (items !== null && itemsOk && sharesOk && amountOk && !sameShares(entry.shares, computeShares(items))) {
		problem("shares", "The shares don't match the items");
	}
	return problems;
}

export function summarizeGroup(entries: Iterable<LedgerEntry>, members: LedgerMember[]): GroupSummary {
	const byId = new Map(members.map((member) => [member.id, member]));
	const known = (id: string) => {
		if (!byId.has(id)) throw new RangeError(`Unknown member ${id}`);
	};

	const balance = new Map<string, number>();
	const owes = new Map<string, Map<string, number>>();

	for (const entry of entries) {
		if (entry.deletedAt !== null) continue;
		if (entry.kind === "payment" && entry.paymentStatus !== "confirmed") continue;
		for (const share of entry.shares) {
			known(share.memberId);
			balance.set(share.memberId, (balance.get(share.memberId) ?? 0) + share.paidCents - share.owedCents);
			const row = owes.get(share.memberId) ?? new Map<string, number>();
			for (const [payer, cents] of Object.entries(share.owedTo)) {
				known(payer);
				row.set(payer, (row.get(payer) ?? 0) + cents);
			}
			owes.set(share.memberId, row);
		}
	}

	const name = (id: string) => byId.get(id)!.displayName;
	const compare = (a: string, b: string) =>
		name(a).localeCompare(name(b), "en", { sensitivity: "accent" }) || (a < b ? -1 : a > b ? 1 : 0);

	const people: PersonSummary[] = [...balance.entries()]
		.map(([memberId, balanceCents]) => ({
			memberId,
			balanceCents,
			state: balanceCents < 0 ? ("owes" as const) : balanceCents > 0 ? ("owed" as const) : ("settled" as const),
		}))
		.sort((a, b) => compare(a.memberId, b.memberId));

	const debts: Debt[] = [];
	for (const [a, row] of owes) {
		for (const [b, cents] of row) {
			if (a === b) continue;
			const net = cents - (owes.get(b)?.get(a) ?? 0);
			if (net > 0) debts.push({ fromMemberId: a, toMemberId: b, amountCents: net });
		}
	}
	debts.sort((x, y) => compare(x.fromMemberId, y.fromMemberId) || compare(x.toMemberId, y.toMemberId));

	return { people, debts };
}
