import { useLiveQuery } from "dexie-react-hooks";

import { groupCategory } from "@/lib/categories";
import { toLedgerMembers } from "@/lib/changes";
import { summarizeGroup } from "@/lib/ledger";
import { db } from "@/lib/local-db";
import type { Category, EntryRow } from "@/lib/sync/types";

// Bills and payments of every status, without deleted bills: newest day first, then latest added first.
export function useEntries(groupId: string) {
	return useLiveQuery(
		async () =>
			(await db.entries.where("groupId").equals(groupId).toArray())
				.filter((e) => !e.deletedAt)
				.sort(
					(a, b) =>
						b.entryDate.localeCompare(a.entryDate) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
				),
		[groupId]
	);
}

// undefined while loading, null when this device doesn't have it (deleted bills are returned).
export function useEntry(entryId: string) {
	return useLiveQuery(async () => (await db.entries.get(entryId)) ?? null, [entryId]);
}

// Balances and pairwise debts, worked out on the device.
export function useGroupSummary(groupId: string) {
	return useLiveQuery(async () => {
		const [entries, members] = await Promise.all([
			db.entries.where("groupId").equals(groupId).toArray(),
			db.members.where("groupId").equals(groupId).toArray(),
		]);
		return summarizeGroup(entries, toLedgerMembers(members));
	}, [groupId]);
}

// Payments waiting for an answer, oldest first. Screens show each to its two people only.
export function usePendingPayments(groupId: string) {
	return useLiveQuery(
		async () =>
			(await db.entries.where("groupId").equals(groupId).toArray())
				.filter((e) => e.kind === "payment" && e.paymentStatus === "pending")
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
		[groupId]
	);
}

// An entry's open conflicts, oldest first (the resolver works through them in that order).
export function useConflicts(entryId: string) {
	return useLiveQuery(
		async () =>
			(await db.conflicts.where("entryId").equals(entryId).toArray())
				.filter((c) => !c.resolvedAt)
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
		[entryId]
	);
}

// Every open conflict in the group, oldest first: the popup and the Needs resolving badges.
export function useOpenConflicts(groupId: string) {
	return useLiveQuery(
		async () =>
			(await db.conflicts.where("groupId").equals(groupId).toArray())
				.filter((c) => !c.resolvedAt)
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
		[groupId]
	);
}

// The cover's category: undefined while loading, null when no live bill has one (the "new" hand).
export function useGroupCategory(groupId: string) {
	return useLiveQuery(
		async () => groupCategory(await db.entries.where("groupId").equals(groupId).toArray()),
		[groupId]
	);
}

// Every group's cover category at once, for the groups list: group id -> category or null.
export function useGroupCategories() {
	return useLiveQuery(async () => {
		const byGroup = new Map<string, EntryRow[]>();
		for (const entry of await db.entries.toArray()) {
			const list = byGroup.get(entry.groupId);
			if (list) list.push(entry);
			else byGroup.set(entry.groupId, [entry]);
		}
		const categories = new Map<string, Category | null>();
		for (const group of await db.groups.toArray()) categories.set(group.id, groupCategory(byGroup.get(group.id) ?? []));
		return categories;
	});
}
