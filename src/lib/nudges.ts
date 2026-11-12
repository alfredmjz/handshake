import { useLiveQuery } from "dexie-react-hooks";

import { useCurrentUser } from "@/lib/auth";
import { db } from "@/lib/local-db";
import { lastNudge, receivedNudges, unseenCount, type ReceivedNudge } from "@/lib/nudge-view";

// Local only, never synced: the ids of nudges to me already seen when the bell was last opened. Local data
// belongs to one account (claimLocalData), so this is per user.
const SEEN_KEY = "seenNudgeIds";

async function seenIds(): Promise<Set<string>> {
	const entry = await db.meta.get(SEEN_KEY);
	try {
		return new Set(entry ? (JSON.parse(entry.value) as string[]) : []);
	} catch {
		return new Set();
	}
}

async function readReceived(userId: string): Promise<ReceivedNudge[]> {
	const members = await db.members.toArray();
	const mine = members.filter((m) => m.userId === userId && !m.deletedAt).map((m) => m.id);
	const [nudges, groups, seen] = await Promise.all([
		db.nudges.where("toMemberId").anyOf(mine).toArray(),
		db.groups.toArray(),
		seenIds(),
	]);
	return receivedNudges(nudges, groups, members, userId, seen);
}

// Nudges sent to me across my groups, newest first, each with groupName, fromName and unseen.
export function useNudgesToMe() {
	const { id: userId } = useCurrentUser();
	return useLiveQuery(() => readReceived(userId), [userId]);
}

// The newest nudge from one person to another in the group: undefined while loading, null when none.
// From me: the Nudge button ("Nudged today" while nudgedRecently). To me: the debt card's notice.
export function useLastNudge(groupId: string, fromMemberId: string, toMemberId: string) {
	return useLiveQuery(
		async () => lastNudge(await db.nudges.where("groupId").equals(groupId).toArray(), fromMemberId, toMemberId),
		[groupId, fromMemberId, toMemberId]
	);
}

// The bell's count: nudges to me not yet seen on this device. 0 while loading.
export function useUnseenNudgeCount() {
	const { id: userId } = useCurrentUser();
	return useLiveQuery(async () => unseenCount(await readReceived(userId)), [userId], 0);
}

// Call when the bell opens: every nudge to me on this device counts as seen.
export async function markNudgesSeen(userId: string) {
	const ids = (await readReceived(userId)).map((n) => n.id);
	await db.meta.put({ key: SEEN_KEY, value: JSON.stringify(ids) });
}
