import type { ExpenseDraft } from "@/lib/changes";
import type { Category, ConflictResolution, EntryRow, Item, Share } from "@/lib/sync/types";

// Pure helpers for the group and entry screens: how entries are grouped, who sees what, and conflicts.

export type DayGroup<T> = { date: string; entries: T[] };

// Runs of entries on the same day, in the order given (useEntries sorts newest first).
export function groupByDay<T extends { entryDate: string }>(entries: readonly T[]): DayGroup<T>[] {
	const days: DayGroup<T>[] = [];
	for (const entry of entries) {
		const last = days.at(-1);
		if (last && last.date === entry.entryDate) last.entries.push(entry);
		else days.push({ date: entry.entryDate, entries: [entry] });
	}
	return days;
}

function utcDate(date: string): Date {
	const [y, m, d] = date.slice(0, 10).split("-").map(Number);
	const at = new Date(0);
	at.setUTCFullYear(y, m - 1, d);
	return at;
}

// "Tue 4 Nov"; the year is added when it isn't this year ("Sat 3 Jan 2026").
export function dayLabel(date: string, today: string): string {
	const at = utcDate(date);
	const weekday = at.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
	return `${weekday} ${shortDate(date, today)}`;
}

// "3 Nov" for a calendar date or a timestamp (in local time), with the year when it isn't this year.
export function shortDate(value: string, today: string): string {
	const local = value.length > 10 ? new Date(value) : utcDate(value);
	const timeZone = value.length > 10 ? undefined : "UTC";
	const year = value.length > 10 ? String(local.getFullYear()) : value.slice(0, 4);
	return local.toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
		year: year === today.slice(0, 4) ? undefined : "numeric",
		timeZone,
	});
}

// "Alex", "Alex and Sam", "Alex, Jo and Sam".
export function joinNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// A list of names that starts a sentence: "You and Sam", "Alex and you".
export function sentenceList(names: readonly string[]): string {
	return joinNames(names.map((name, i) => (i > 0 && name === "You" ? "you" : name)));
}

type PaymentLike = Pick<EntryRow, "kind" | "paymentStatus" | "shares">;

// Everyone sees bills and payments that count; a pending, declined or undone payment only its two people.
export function isVisibleTo(entry: PaymentLike, memberId: string | null | undefined): boolean {
	if (entry.kind !== "payment" || entry.paymentStatus === "confirmed") return true;
	return !!memberId && entry.shares.some((s) => s.memberId === memberId);
}

export type Effect = { kind: "lent" | "owe" | "even" | "none"; cents: number };

// What a bill means for one person: lent (paid more than their share), owe, even, or not involved.
export function effectOn(entry: Pick<EntryRow, "kind" | "shares">, memberId: string | null | undefined): Effect {
	const share = memberId ? entry.shares.find((s) => s.memberId === memberId) : undefined;
	if (!share || entry.kind !== "expense") return { kind: "none", cents: 0 };
	const net = share.paidCents - share.owedCents;
	if (net > 0) return { kind: "lent", cents: net };
	if (net < 0) return { kind: "owe", cents: -net };
	return { kind: "even", cents: share.owedCents };
}

// Members who paid for a bill, in share order.
export function payerIds(entry: Pick<EntryRow, "shares">): string[] {
	return entry.shares.filter((s) => s.paidCents > 0).map((s) => s.memberId);
}

// Cents each person's owed amount differs from rounding each payer's part normally: the cent a payer
// covers (+1) or has taken off (−1). Only non-zero differences are returned.
export function roundingCents(items: readonly Item[], shares: readonly Share[]): Map<string, number> {
	const normal = new Map<string, bigint>();
	for (const payer of new Set(items.map((i) => i.paidBy))) {
		const payerItems = items.filter((i) => i.paidBy === payer && i.splitAmong.length > 0);
		let d = 1n;
		for (const item of payerItems) d = lcm(d, BigInt(item.splitAmong.length));
		const num = new Map<string, bigint>();
		for (const item of payerItems) {
			const each = BigInt(item.amountCents) * (d / BigInt(item.splitAmong.length));
			for (const who of item.splitAmong) num.set(who, (num.get(who) ?? 0n) + each);
		}
		for (const [who, n] of num) normal.set(who, (normal.get(who) ?? 0n) + (2n * n + d) / (2n * d));
	}
	const result = new Map<string, number>();
	for (const share of shares) {
		const diff = share.owedCents - Number(normal.get(share.memberId) ?? 0n);
		if (diff !== 0) result.set(share.memberId, diff);
	}
	return result;
}

function gcd(a: bigint, b: bigint): bigint {
	return b === 0n ? a : gcd(b, a % b);
}

function lcm(a: bigint, b: bigint): bigint {
	return (a / gcd(a, b)) * b;
}

// The parts of a bill a conflict can differ in.
export type BillVersion = {
	description: string;
	entryDate: string;
	notes: string | null;
	category: Category | null;
	items: readonly Item[];
};

export type Side = "current" | "proposed";

// description, entryDate, notes, category, then item:0, item:1, … (items are matched by position).
export type ConflictField = { key: string; changed: boolean };

export function sameItem(a: Item | undefined, b: Item | undefined): boolean {
	if (!a || !b) return a === b;
	const people = (i: Item) => [...i.splitAmong].sort().join(",");
	return (
		a.amountCents === b.amountCents &&
		a.paidBy === b.paidBy &&
		(a.description ?? "") === (b.description ?? "") &&
		people(a) === people(b)
	);
}

export function conflictFields(current: BillVersion, proposed: BillVersion): ConflictField[] {
	const fields: ConflictField[] = [
		{ key: "description", changed: current.description !== proposed.description },
		{ key: "entryDate", changed: current.entryDate !== proposed.entryDate },
		{ key: "notes", changed: (current.notes ?? "") !== (proposed.notes ?? "") },
		{ key: "category", changed: current.category !== proposed.category },
	];
	const count = Math.max(current.items.length, proposed.items.length);
	for (let i = 0; i < count; i++)
		fields.push({ key: `item:${i}`, changed: !sameItem(current.items[i], proposed.items[i]) });
	return fields;
}

// The bill made from a choice per field; unchosen fields keep the current version. An item missing on
// the chosen side is left out.
export function mergeVersions(
	current: BillVersion,
	proposed: BillVersion,
	choices: Readonly<Record<string, Side>>
): ExpenseDraft {
	const pick = (key: string) => (choices[key] === "proposed" ? proposed : current);
	const items: Item[] = [];
	const count = Math.max(current.items.length, proposed.items.length);
	for (let i = 0; i < count; i++) {
		const item = pick(`item:${i}`).items[i];
		if (item) items.push({ ...item, splitAmong: [...item.splitAmong] });
	}
	return {
		description: pick("description").description,
		entryDate: pick("entryDate").entryDate,
		notes: pick("notes").notes,
		category: pick("category").category,
		items,
	};
}

// kept_current or took_proposed when every changed field came from one side, merged otherwise.
export function resolutionOf(
	fields: readonly ConflictField[],
	choices: Readonly<Record<string, Side>>
): ConflictResolution {
	const sides = new Set(fields.filter((f) => f.changed).map((f) => choices[f.key] ?? "current"));
	if (sides.size > 1) return "merged";
	return sides.has("proposed") ? "took_proposed" : "kept_current";
}

export function billVersionOf(entry: Pick<EntryRow, "description" | "entryDate" | "notes" | "category" | "items">) {
	return {
		description: entry.description,
		entryDate: entry.entryDate,
		notes: entry.notes,
		category: entry.category,
		items: entry.items ?? [],
	} satisfies BillVersion;
}

// The starting choice per changed field: the side that changed it since the version both started from
// (base), so edits to different fields merge on their own. Without a base, or when both changed it, the
// current version.
export function defaultChoices(
	base: BillVersion | null,
	current: BillVersion,
	proposed: BillVersion
): Record<string, Side> {
	const choices: Record<string, Side> = {};
	if (!base) return choices;
	const fromBase = new Map(conflictFields(base, current).map((f) => [f.key, f.changed]));
	for (const field of conflictFields(current, proposed)) {
		if (field.changed && fromBase.get(field.key) === false) choices[field.key] = "proposed";
	}
	return choices;
}
