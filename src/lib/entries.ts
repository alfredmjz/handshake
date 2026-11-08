import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@/lib/local-db";

// Read hooks only. Balances and debts come from summarizeGroup (src/lib/ledger.ts) over these rows.

// Every entry of the group, newest day first, deleted ones included (summarizeGroup skips them).
export function useEntries(groupId: string) {
	return useLiveQuery(
		async () =>
			(await db.entries.where("groupId").equals(groupId).toArray()).sort(
				(a, b) => b.entryDate.localeCompare(a.entryDate) || b.createdAt.localeCompare(a.createdAt)
			),
		[groupId]
	);
}

// Conflicts still waiting to be resolved, oldest first.
export function useOpenConflicts(groupId: string) {
	return useLiveQuery(
		async () =>
			(
				await db.conflicts
					.where("groupId")
					.equals(groupId)
					.filter((c) => !c.resolvedAt)
					.toArray()
			).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
		[groupId]
	);
}
