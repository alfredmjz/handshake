import type { Category, EntryRow } from "@/lib/sync/types";

// The editor's order.
export const CATEGORIES: readonly { id: Category; label: string }[] = [
	{ id: "food", label: "Food" },
	{ id: "drinks", label: "Drinks" },
	{ id: "stay", label: "Stay" },
	{ id: "travel", label: "Travel" },
	{ id: "groceries", label: "Groceries" },
	{ id: "fun", label: "Fun" },
];

export function isCategory(value: unknown): value is Category {
	return CATEGORIES.some((c) => c.id === value);
}

type CategorisedEntry = Pick<EntryRow, "kind" | "deletedAt" | "category" | "entryDate" | "createdAt" | "id">;

// > 0 when a is more recent than b: a later day, then added later (as the entry list sorts).
function newer(a: CategorisedEntry, b: CategorisedEntry) {
	return a.entryDate.localeCompare(b.entryDate) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

// The group's cover category: the most common one among its live bills. A tie goes to the category of the
// most recent bill among the tied ones; no categorised bills gives null.
export function groupCategory(entries: Iterable<CategorisedEntry>): Category | null {
	const counts = new Map<Category, { count: number; latest: CategorisedEntry }>();
	for (const entry of entries) {
		if (entry.kind !== "expense" || entry.deletedAt || !entry.category) continue;
		const seen = counts.get(entry.category);
		if (!seen) counts.set(entry.category, { count: 1, latest: entry });
		else {
			seen.count += 1;
			if (newer(entry, seen.latest) > 0) seen.latest = entry;
		}
	}

	let best: { category: Category; count: number; latest: CategorisedEntry } | null = null;
	for (const [category, { count, latest }] of counts) {
		if (!best || count > best.count || (count === best.count && newer(latest, best.latest) > 0))
			best = { category, count, latest };
	}
	return best?.category ?? null;
}
