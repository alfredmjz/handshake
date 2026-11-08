import { computeShares } from "@/lib/ledger";
import type {
	BillFields,
	ConflictRow,
	CursorRow,
	EntryRow,
	GroupRow,
	InviteRow,
	InviteTokenRow,
	MemberRow,
	Mutation,
	PullResult,
} from "@/lib/sync/types";

// One local table: Dexie in the app, a Map in tests. `get` is by primary key (inviteTokens: inviteId,
// cursors: groupId).
export interface Rows<T> {
	get(id: string): Promise<T | undefined>;
	byGroup(groupId: string): Promise<T[]>;
	put(rows: T[]): Promise<void>;
	delete(ids: string[]): Promise<void>;
}

export interface LocalTables {
	groups: Rows<GroupRow>;
	members: Rows<MemberRow>;
	entries: Rows<EntryRow>;
	conflicts: Rows<ConflictRow>;
	invites: Rows<InviteRow>;
	inviteTokens: Rows<InviteTokenRow>;
	cursors: Rows<CursorRow>;
	groupIds(): Promise<string[]>;
}

type Of<T extends Mutation["type"]> = Extract<Mutation, { type: T }>;

// The caller's own member row in the group, if any.
async function myMember(tables: LocalTables, groupId: string, userId: string) {
	return (await tables.members.byGroup(groupId)).find((member) => member.userId === userId && !member.deletedAt);
}

const canAnswer = (member: MemberRow | undefined) => !!member && member.userId !== null && !member.deletedAt;

function billFields(fields: BillFields) {
	return {
		description: fields.description.trim(),
		amountCents: fields.amountCents,
		entryDate: fields.entryDate,
		notes: fields.notes,
		items: fields.items,
		shares: fields.shares,
	};
}

async function updateEntry(tables: LocalTables, id: string, change: (entry: EntryRow) => EntryRow | null) {
	const entry = await tables.entries.get(id);
	const next = entry && change(entry);
	if (next) await tables.entries.put([next]);
}

// Shows a mutation's effect on this device, closely enough to display, without inventing server-only
// fields. A create whose row is already here does nothing: the server's copy wins.
export async function applyMutation(tables: LocalTables, mutation: Mutation, userId: string): Promise<void> {
	const at = mutation.at;
	switch (mutation.type) {
		case "group.create": {
			if (await tables.groups.get(mutation.groupId)) return;
			await tables.groups.put([
				{
					id: mutation.groupId,
					name: mutation.name.trim(),
					createdBy: userId,
					createdAt: at,
					deletedAt: null,
					completedAt: null,
					completedByMemberId: null,
					rowVersion: 0,
				},
			]);
			await tables.members.put([
				{
					id: mutation.memberId,
					groupId: mutation.groupId,
					userId,
					displayName: mutation.displayName.trim(),
					role: "owner",
					joinedAt: at,
					deletedAt: null,
					rowVersion: 0,
				},
			]);
			return;
		}
		case "group.rename":
			return updateGroup(tables, mutation.groupId, (group) => ({ ...group, name: mutation.name.trim() }));
		case "group.delete":
			return updateGroup(tables, mutation.groupId, (group) => ({ ...group, deletedAt: group.deletedAt ?? at }));
		case "group.complete": {
			const me = await myMember(tables, mutation.groupId, userId);
			return updateGroup(tables, mutation.groupId, (group) =>
				group.completedAt ? group : { ...group, completedAt: at, completedByMemberId: me?.id ?? null }
			);
		}
		case "group.reopen":
			return updateGroup(tables, mutation.groupId, (group) => ({
				...group,
				completedAt: null,
				completedByMemberId: null,
			}));
		case "member.add": {
			if (await tables.members.get(mutation.memberId)) return;
			await tables.members.put([
				{
					id: mutation.memberId,
					groupId: mutation.groupId,
					userId: null,
					displayName: mutation.displayName.trim(),
					role: "member",
					joinedAt: null,
					deletedAt: null,
					rowVersion: 0,
				},
			]);
			return;
		}
		case "member.rename": {
			const member = await tables.members.get(mutation.memberId);
			if (member) await tables.members.put([{ ...member, displayName: mutation.displayName.trim() }]);
			return;
		}
		case "member.remove":
			return removeMember(tables, mutation, userId);
		case "entry.create": {
			if (await tables.entries.get(mutation.entryId)) return;
			const me = await myMember(tables, mutation.groupId, userId);
			if (!me) return;
			await tables.entries.put([
				{
					id: mutation.entryId,
					groupId: mutation.groupId,
					kind: "expense",
					...billFields(mutation),
					paymentStatus: null,
					payerConfirmedAt: null,
					receiverConfirmedAt: null,
					confirmedAt: null,
					closedAt: null,
					closeNote: null,
					createdByMemberId: me.id,
					updatedByMemberId: me.id,
					createdAt: at,
					updatedAt: at,
					deletedAt: null,
					rowVersion: 0,
				},
			]);
			return;
		}
		case "entry.update": {
			const me = await myMember(tables, mutation.groupId, userId);
			return updateEntry(tables, mutation.entryId, (entry) =>
				entry.kind !== "expense" || !me
					? null
					: { ...entry, ...billFields(mutation), updatedByMemberId: me.id, updatedAt: at, deletedAt: null }
			);
		}
		case "entry.delete": {
			const me = await myMember(tables, mutation.groupId, userId);
			return updateEntry(tables, mutation.entryId, (entry) =>
				entry.kind !== "expense" || entry.deletedAt || !me
					? null
					: { ...entry, deletedAt: at, updatedByMemberId: me.id, updatedAt: at }
			);
		}
		case "conflict.resolve":
			return resolveConflict(tables, mutation, userId);
		case "invite.create": {
			// The token is kept even once the server's copy of the invite has arrived.
			await tables.inviteTokens.put([
				{ inviteId: mutation.inviteId, groupId: mutation.groupId, token: mutation.token },
			]);
			if (await tables.invites.get(mutation.inviteId)) return;
			await tables.invites.put([
				{
					id: mutation.inviteId,
					groupId: mutation.groupId,
					claimMemberId: mutation.claimMemberId,
					createdBy: userId,
					createdAt: at,
					expiresAt: mutation.expiresAt,
					revokedAt: null,
					rowVersion: 0,
				},
			]);
			return;
		}
		case "invite.revoke": {
			const invite = await tables.invites.get(mutation.inviteId);
			if (invite && !invite.revokedAt) await tables.invites.put([{ ...invite, revokedAt: at }]);
			return;
		}
		case "payment.record":
			return recordPayment(tables, mutation, userId);
		case "payment.confirm":
		case "payment.decline":
		case "payment.undo":
			return answerPayment(tables, mutation, userId);
	}
}

async function updateGroup(tables: LocalTables, groupId: string, change: (group: GroupRow) => GroupRow) {
	const group = await tables.groups.get(groupId);
	if (group) await tables.groups.put([change(group)]);
}

// Leaving or being removed: the row stays (soft delete), the person's pending payments are undone, and
// an owner who leaves hands the group to the full member who joined first, or deletes it.
async function removeMember(tables: LocalTables, mutation: Of<"member.remove">, userId: string) {
	const members = await tables.members.byGroup(mutation.groupId);
	const target = members.find((member) => member.id === mutation.memberId);
	if (!target || target.deletedAt) return;
	const at = mutation.at;
	const me = members.find((member) => member.userId === userId && !member.deletedAt);

	await tables.members.put([{ ...target, deletedAt: at, role: target.role === "owner" ? "member" : target.role }]);

	const pending = (await tables.entries.byGroup(mutation.groupId)).filter(
		(entry) => entry.paymentStatus === "pending" && entry.shares.some((share) => share.memberId === target.id)
	);
	await tables.entries.put(
		pending.map((entry) => ({
			...entry,
			paymentStatus: "undone",
			closedAt: at,
			updatedByMemberId: me?.id ?? entry.updatedByMemberId,
			updatedAt: at,
		}))
	);

	if (target.role !== "owner") return;
	const heir = members
		.filter((member) => member.id !== target.id && member.role === "member" && member.userId && !member.deletedAt)
		.sort((a, b) => (a.joinedAt ?? "").localeCompare(b.joinedAt ?? "") || a.id.localeCompare(b.id))[0];
	if (heir) await tables.members.put([{ ...heir, role: "owner" }]);
	else await updateGroup(tables, mutation.groupId, (group) => ({ ...group, deletedAt: group.deletedAt ?? at }));
}

async function resolveConflict(tables: LocalTables, mutation: Of<"conflict.resolve">, userId: string) {
	const conflict = await tables.conflicts.get(mutation.conflictId);
	// Someone else got there first: their result stands.
	if (!conflict || conflict.resolvedAt) return;
	const me = await myMember(tables, mutation.groupId, userId);
	if (!me) return;
	const at = mutation.at;

	await tables.conflicts.put([
		{ ...conflict, resolvedAt: at, resolvedByMemberId: me.id, resolution: mutation.resolution },
	]);
	const final = mutation.entry;
	await updateEntry(tables, conflict.entryId, (entry) =>
		"deleted" in final
			? { ...entry, deletedAt: entry.deletedAt ?? at, updatedByMemberId: me.id, updatedAt: at }
			: { ...entry, ...billFields(final), deletedAt: null, updatedByMemberId: me.id, updatedAt: at }
	);
}

// Recording counts as the recorder's side agreeing. With nobody on the other side able to answer, it
// counts at once (spec decision 17).
async function recordPayment(tables: LocalTables, mutation: Of<"payment.record">, userId: string) {
	if (await tables.entries.get(mutation.entryId)) return;
	const members = await tables.members.byGroup(mutation.groupId);
	const me = members.find((member) => member.userId === userId && !member.deletedAt);
	if (!me) return;
	const from = members.find((member) => member.id === mutation.fromMemberId);
	const to = members.find((member) => member.id === mutation.toMemberId);
	const otherCanAnswer = me.id === from?.id ? canAnswer(to) : me.id === to?.id ? canAnswer(from) : false;
	const at = mutation.at;

	await tables.entries.put([
		{
			id: mutation.entryId,
			groupId: mutation.groupId,
			kind: "payment",
			description: "Payment",
			amountCents: mutation.amountCents,
			items: null,
			entryDate: mutation.entryDate,
			notes: mutation.notes,
			paymentStatus: otherCanAnswer ? "pending" : "confirmed",
			payerConfirmedAt: me.id === mutation.fromMemberId ? at : null,
			receiverConfirmedAt: me.id === mutation.toMemberId ? at : null,
			confirmedAt: otherCanAnswer ? null : at,
			closedAt: null,
			closeNote: null,
			createdByMemberId: me.id,
			updatedByMemberId: me.id,
			createdAt: at,
			updatedAt: at,
			deletedAt: null,
			rowVersion: 0,
			shares: computeShares([
				{
					id: mutation.entryId,
					amountCents: mutation.amountCents,
					paidBy: mutation.fromMemberId,
					splitAmong: [mutation.toMemberId],
				},
			]),
		},
	]);
}

async function answerPayment(
	tables: LocalTables,
	mutation: Of<"payment.confirm" | "payment.decline" | "payment.undo">,
	userId: string
) {
	const me = await myMember(tables, mutation.groupId, userId);
	if (!me) return;
	const at = mutation.at;
	await updateEntry(tables, mutation.entryId, (entry) => {
		if (entry.kind !== "payment" || entry.paymentStatus !== "pending") return null;
		const answered = { ...entry, updatedByMemberId: me.id, updatedAt: at };
		switch (mutation.type) {
			case "payment.confirm": {
				const asPayer = entry.shares.some((share) => share.memberId === me.id && share.paidCents > 0);
				return {
					...answered,
					paymentStatus: "confirmed",
					payerConfirmedAt: asPayer ? at : entry.payerConfirmedAt,
					receiverConfirmedAt: asPayer ? entry.receiverConfirmedAt : at,
					confirmedAt: at,
				};
			}
			case "payment.decline":
				return { ...answered, paymentStatus: "declined", closedAt: at, closeNote: mutation.note?.trim() || null };
			case "payment.undo":
				return { ...answered, paymentStatus: "undone", closedAt: at };
		}
	});
}

// Drops a group and every row that belongs to it.
async function dropGroup(tables: LocalTables, groupId: string) {
	const ids = <T>(rows: T[], key: (row: T) => string) => rows.map(key);
	await tables.members.delete(ids(await tables.members.byGroup(groupId), (r) => r.id));
	await tables.entries.delete(ids(await tables.entries.byGroup(groupId), (r) => r.id));
	await tables.conflicts.delete(ids(await tables.conflicts.byGroup(groupId), (r) => r.id));
	await tables.invites.delete(ids(await tables.invites.byGroup(groupId), (r) => r.id));
	await tables.inviteTokens.delete(ids(await tables.inviteTokens.byGroup(groupId), (r) => r.inviteId));
	await tables.cursors.delete([groupId]);
	await tables.groups.delete([groupId]);
}

// A change the server will turn into a conflict (§4.2): an unsent edit or delete of a bill that is now
// newer than the version it started from, and was last changed by someone else.
async function isStale(tables: LocalTables, mutation: Mutation, userId: string): Promise<boolean> {
	if (mutation.type !== "entry.update" && mutation.type !== "entry.delete") return false;
	const entry = await tables.entries.get(mutation.entryId);
	if (!entry || entry.rowVersion <= mutation.baseVersion) return false;
	const me = await myMember(tables, mutation.groupId, userId);
	return entry.updatedByMemberId !== me?.id;
}

// `pending` must be read in the same transaction as this merge, so changes made while the pull was
// in flight are replayed too.
export async function mergePull(tables: LocalTables, pull: PullResult, pending: Mutation[], userId: string) {
	// Groups created here that haven't reached the server yet are missing from groupIds; keep them.
	const keep = new Set([...pull.groupIds, ...pending.flatMap((m) => (m.type === "group.create" ? [m.groupId] : []))]);
	for (const groupId of await tables.groupIds()) {
		if (!keep.has(groupId)) await dropGroup(tables, groupId);
	}

	for (const change of pull.changes) {
		await tables.groups.put(change.groups);
		await tables.members.put(change.members);
		// Each entry arrives whole, with all of its items and shares, and replaces the local copy.
		await tables.entries.put(change.entries);
		await tables.conflicts.put(change.conflicts);
		await tables.invites.put(change.invites);
		await tables.cursors.put([{ groupId: change.groupId, version: change.version }]);
	}

	// Server rows just replaced the local copies; put this device's unsent changes back on top.
	for (const mutation of pending) {
		if (await isStale(tables, mutation, userId)) continue;
		await applyMutation(tables, mutation, userId);
	}
}
