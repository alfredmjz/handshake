import { useLiveQuery } from "dexie-react-hooks";

import { toLedgerMembers } from "@/lib/changes";
import { useCurrentUser } from "@/lib/auth";
import { summarizeGroup } from "@/lib/ledger";
import { db } from "@/lib/local-db";
import { balanceFor, type OpenDebt } from "@/lib/shell-view";

export type GroupStanding = {
	balanceCents: number;
	// Other people still in the group.
	others: number;
};

async function readStandings(userId: string) {
	const groups = (await db.groups.toArray()).filter((g) => !g.deletedAt);
	return Promise.all(
		groups.map(async (group) => {
			const [entries, members] = await Promise.all([
				db.entries.where("groupId").equals(group.id).toArray(),
				db.members.where("groupId").equals(group.id).toArray(),
			]);
			const me = members.find((m) => m.userId === userId && !m.deletedAt) ?? null;
			return { group, members, me, summary: summarizeGroup(entries, toLedgerMembers(members)) };
		})
	);
}

// Your balance in every group, computed from the rows on this device (works offline).
export function useMyBalances() {
	const { id: userId } = useCurrentUser();
	return useLiveQuery(async () => {
		const map = new Map<string, GroupStanding>();
		for (const { group, members, me, summary } of await readStandings(userId)) {
			map.set(group.id, {
				balanceCents: balanceFor(summary.people, me?.id),
				others: members.filter((m) => !m.deletedAt && m.id !== me?.id).length,
			});
		}
		return map;
	}, [userId]);
}

// What you still owe or are owed, group by group, for the delete-account dialog.
export function useOpenDebts() {
	const { id: userId } = useCurrentUser();
	return useLiveQuery(async () => {
		const out: OpenDebt[] = [];
		for (const { group, members, me, summary } of await readStandings(userId)) {
			if (!me) continue;
			const nameOf = (id: string) => members.find((m) => m.id === id)?.displayName ?? "Someone";
			for (const d of summary.debts) {
				if (d.amountCents <= 0) continue;
				if (d.fromMemberId === me.id)
					out.push({ groupName: group.name, otherName: nameOf(d.toMemberId), cents: d.amountCents, direction: "owe" });
				else if (d.toMemberId === me.id)
					out.push({
						groupName: group.name,
						otherName: nameOf(d.fromMemberId),
						cents: d.amountCents,
						direction: "owed",
					});
			}
		}
		return out.sort(
			(a, b) =>
				a.groupName.localeCompare(b.groupName, undefined, { sensitivity: "base" }) ||
				a.otherName.localeCompare(b.otherName, undefined, { sensitivity: "base" })
		);
	}, [userId]);
}
