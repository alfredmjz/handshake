import { isCoverKey } from "@/lib/cover-colors";
import { isSticker } from "@/lib/cover-stickers";
import { nextOwner } from "@/lib/group-access";
import { computeShares } from "@/lib/ledger";
import { readPayment, recordingRule } from "@/lib/payment-rules";
import { storedNote } from "@/lib/stored-text";
import { keptAfterFullPull, pulledRows, rowKey, TABLE_NAMES, type RowOf, type TableName } from "@/lib/sync/tables";
import type { BillFields, EntryRow, GroupChanges, Mutation, MutationOf, PullResult, Share } from "@/lib/sync/types";

export interface Rows<T> {
	get(id: string): Promise<T | undefined>;
	byGroup(groupId: string): Promise<T[]>;
	put(rows: T[]): Promise<void>;
	delete(ids: string[]): Promise<void>;
}

export type ReplicaRows = { [K in TableName]: Rows<RowOf<K>> };

// The local tables sync reads and writes (described in tables.ts): Dexie in the app, plain maps in tests.
export interface LocalTables extends ReplicaRows {
	groupIds(): Promise<string[]>;
}

// "<displayName> is now signed in on another device", for a group this device lost.
export type MovedAwayNotice = { groupId: string; groupName: string; displayName: string };

const INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

// The caller's active member row in the group, as private.caller_member finds it.
async function callerMember(tables: LocalTables, groupId: string, userId: string) {
	return (await tables.members.byGroup(groupId)).find((m) => m.userId === userId && !m.deletedAt);
}

// A payment's shares are one item paid by `from`, split to `to` (architecture §9.3).
function paymentShares(from: string, to: string, amountCents: number): Share[] {
	return computeShares([{ id: "payment", amountCents, paidBy: from, splitAmong: [to] }]);
}

function billFields(fields: BillFields) {
	return {
		description: fields.description.trim(),
		amountCents: fields.amountCents,
		items: fields.items,
		entryDate: fields.entryDate,
		notes: fields.notes,
		category: fields.category ?? null,
		shares: fields.shares,
	};
}

async function pendingPayment(tables: LocalTables, groupId: string, entryId: string) {
	const entry = await tables.entries.get(entryId);
	return entry && entry.groupId === groupId && readPayment(entry)?.status === "pending" ? entry : undefined;
}

async function handOver(tables: LocalTables, groupId: string, leavingId: string, at: string) {
	const heir = nextOwner(await tables.members.byGroup(groupId), leavingId);
	if (heir) {
		await tables.members.put([{ ...heir, role: "owner" }]);
		return;
	}
	const group = await tables.groups.get(groupId);
	if (group && !group.deletedAt) await tables.groups.put([{ ...group, deletedAt: at }]);
}

async function recordPayment(tables: LocalTables, m: MutationOf<"payment.record">, userId: string) {
	if (await tables.entries.get(m.entryId)) return;
	const me = await callerMember(tables, m.groupId, userId);
	const members = await tables.members.byGroup(m.groupId);
	const from = members.find((x) => x.id === m.fromMemberId);
	const to = members.find((x) => x.id === m.toMemberId);
	// The server refuses amounts computeShares can't split.
	if (!me || !from || !to || from.id === to.id || !Number.isSafeInteger(m.amountCents) || m.amountCents <= 0) return;

	const counts = recordingRule(me.id, from, to).countsAtOnce;
	await tables.entries.put([
		{
			id: m.entryId,
			groupId: m.groupId,
			kind: "payment",
			description: m.description?.trim() || "Payment",
			amountCents: m.amountCents,
			items: null,
			entryDate: m.entryDate,
			notes: m.notes,
			category: null,
			paymentStatus: counts ? "confirmed" : "pending",
			payerConfirmedAt: me.id === from.id ? m.at : null,
			receiverConfirmedAt: me.id === to.id ? m.at : null,
			confirmedAt: counts ? m.at : null,
			closedAt: null,
			closeNote: null,
			createdByMemberId: me.id,
			updatedByMemberId: me.id,
			createdAt: m.at,
			updatedAt: m.at,
			deletedAt: null,
			rowVersion: 0,
			shares: paymentShares(from.id, to.id, m.amountCents),
		},
	]);
}

async function answerPayment(
	tables: LocalTables,
	m: MutationOf<"payment.confirm"> | MutationOf<"payment.decline">,
	userId: string
) {
	const entry = await pendingPayment(tables, m.groupId, m.entryId);
	const me = await callerMember(tables, m.groupId, userId);
	if (!entry || !me) return;

	const side = readPayment(entry, me.id)?.answeringAs;
	if (!side) return;

	const answered = { ...entry, updatedByMemberId: me.id, updatedAt: m.at };
	if (m.type === "payment.confirm") {
		await tables.entries.put([
			{
				...answered,
				paymentStatus: "confirmed",
				payerConfirmedAt: side === "payer" ? m.at : entry.payerConfirmedAt,
				receiverConfirmedAt: side === "receiver" ? m.at : entry.receiverConfirmedAt,
				confirmedAt: m.at,
			},
		]);
	} else {
		await tables.entries.put([{ ...answered, paymentStatus: "declined", closedAt: m.at, closeNote: m.note }]);
	}
}

async function removeMember(tables: LocalTables, m: MutationOf<"member.remove">) {
	const target = await tables.members.get(m.memberId);
	if (!target || target.groupId !== m.groupId || target.deletedAt) return;

	await tables.members.put([{ ...target, deletedAt: m.at, role: target.role === "owner" ? "member" : target.role }]);

	// private.undo_pending_payments: nobody would be left to answer them.
	const undone = (await tables.entries.byGroup(m.groupId))
		.filter((e) => {
			const payment = readPayment(e, target.id);
			return payment?.status === "pending" && payment.side !== null;
		})
		.map((e) => ({
			...e,
			paymentStatus: "undone" as const,
			closedAt: m.at,
			updatedByMemberId: target.id,
			updatedAt: m.at,
		}));
	if (undone.length > 0) await tables.entries.put(undone);

	if (target.role === "owner") await handOver(tables, m.groupId, target.id, m.at);
}

async function saveBill(tables: LocalTables, entry: EntryRow, fields: BillFields, memberId: string, at: string) {
	await tables.entries.put([
		{ ...entry, ...billFields(fields), updatedByMemberId: memberId, updatedAt: at, deletedAt: null },
	]);
}

async function deleteBill(tables: LocalTables, entry: EntryRow, memberId: string, at: string) {
	await tables.entries.put([
		{ ...entry, deletedAt: entry.deletedAt ?? at, updatedByMemberId: memberId, updatedAt: at },
	]);
}

async function storedBill(tables: LocalTables, groupId: string, entryId: string) {
	const entry = await tables.entries.get(entryId);
	return entry && entry.groupId === groupId && entry.kind === "expense" ? entry : undefined;
}

// Shows the server's effect on this device, closely enough to display, without inventing what only the
// server knows: new rows have rowVersion 0 and the device's time. A change the server would refuse does
// nothing here; the rejection arrives with the next push.
export async function applyMutation(tables: LocalTables, mutation: Mutation, userId: string): Promise<void> {
	const m = mutation;
	switch (m.type) {
		case "group.create": {
			// Once the server's copy has arrived, it wins.
			if (await tables.groups.get(m.groupId)) return;
			await tables.groups.put([
				{
					id: m.groupId,
					name: m.name.trim(),
					note: storedNote(m.note),
					coverColor: null,
					coverSticker: null,
					createdBy: userId,
					createdAt: m.at,
					deletedAt: null,
					completedAt: null,
					completedByMemberId: null,
					joinCode: null,
					rowVersion: 0,
				},
			]);
			await tables.members.put([
				{
					id: m.memberId,
					groupId: m.groupId,
					userId,
					displayName: m.displayName.trim(),
					role: "owner",
					joinedAt: m.at,
					deletedAt: null,
					rowVersion: 0,
				},
			]);
			return;
		}
		case "group.rename": {
			const group = await tables.groups.get(m.groupId);
			if (group) await tables.groups.put([{ ...group, name: m.name.trim() }]);
			return;
		}
		case "group.describe": {
			const group = await tables.groups.get(m.groupId);
			if (group) await tables.groups.put([{ ...group, note: storedNote(m.note) }]);
			return;
		}
		case "group.recolor": {
			const group = await tables.groups.get(m.groupId);
			const color = m.color === null || isCoverKey(m.color) ? m.color : undefined;
			if (group && color !== undefined) await tables.groups.put([{ ...group, coverColor: color }]);
			return;
		}
		case "group.sticker": {
			const group = await tables.groups.get(m.groupId);
			const sticker = m.sticker === null || isSticker(m.sticker) ? m.sticker : undefined;
			if (group && sticker !== undefined) await tables.groups.put([{ ...group, coverSticker: sticker }]);
			return;
		}
		case "group.delete": {
			const group = await tables.groups.get(m.groupId);
			if (group) await tables.groups.put([{ ...group, deletedAt: m.at }]);
			return;
		}
		case "group.complete": {
			// The server also turns guests without an email into name-only people; the device can't tell
			// which guests those are, so it waits for the pull.
			const group = await tables.groups.get(m.groupId);
			const me = await callerMember(tables, m.groupId, userId);
			if (group && me) await tables.groups.put([{ ...group, completedAt: m.at, completedByMemberId: me.id }]);
			return;
		}
		case "group.reopen": {
			const group = await tables.groups.get(m.groupId);
			if (group?.completedAt) await tables.groups.put([{ ...group, completedAt: null, completedByMemberId: null }]);
			return;
		}
		// Only the server can make the new code; the pull brings it.
		case "group.recode":
			return;
		case "member.add": {
			if (await tables.members.get(m.memberId)) return;
			await tables.members.put([
				{
					id: m.memberId,
					groupId: m.groupId,
					userId: null,
					displayName: m.displayName.trim(),
					role: "member",
					joinedAt: null,
					deletedAt: null,
					rowVersion: 0,
				},
			]);
			return;
		}
		case "member.rename": {
			const member = await tables.members.get(m.memberId);
			if (member && member.groupId === m.groupId)
				await tables.members.put([{ ...member, displayName: m.displayName.trim() }]);
			return;
		}
		case "member.remove":
			return removeMember(tables, m);
		case "entry.create": {
			if (await tables.entries.get(m.entryId)) return;
			const me = await callerMember(tables, m.groupId, userId);
			if (!me) return;
			await tables.entries.put([
				{
					id: m.entryId,
					groupId: m.groupId,
					kind: "expense",
					...billFields(m),
					paymentStatus: null,
					payerConfirmedAt: null,
					receiverConfirmedAt: null,
					confirmedAt: null,
					closedAt: null,
					closeNote: null,
					createdByMemberId: me.id,
					updatedByMemberId: me.id,
					createdAt: m.at,
					updatedAt: m.at,
					deletedAt: null,
					rowVersion: 0,
				},
			]);
			return;
		}
		case "entry.update": {
			const entry = await storedBill(tables, m.groupId, m.entryId);
			const me = await callerMember(tables, m.groupId, userId);
			if (entry && me) await saveBill(tables, entry, m, me.id, m.at);
			return;
		}
		case "entry.delete": {
			const entry = await storedBill(tables, m.groupId, m.entryId);
			const me = await callerMember(tables, m.groupId, userId);
			if (entry && me && !entry.deletedAt) await deleteBill(tables, entry, me.id, m.at);
			return;
		}
		case "conflict.resolve": {
			const conflict = await tables.conflicts.get(m.conflictId);
			const me = await callerMember(tables, m.groupId, userId);
			if (!conflict || conflict.groupId !== m.groupId || conflict.resolvedAt || !me) return;
			if (conflict.entryId !== m.entryId) return;
			const entry = await tables.entries.get(m.entryId);
			if (entry) {
				if ("deleted" in m.entry) await deleteBill(tables, entry, me.id, m.at);
				else await saveBill(tables, entry, m.entry, me.id, m.at);
			}
			await tables.conflicts.put([
				{ ...conflict, resolvedAt: m.at, resolvedByMemberId: me.id, resolution: m.resolution },
			]);
			return;
		}
		case "invite.create": {
			// The token stays on this device only, so the link can be shared again.
			if (!(await tables.inviteTokens.get(m.inviteId)))
				await tables.inviteTokens.put([{ inviteId: m.inviteId, groupId: m.groupId, token: m.token }]);
			if (await tables.invites.get(m.inviteId)) return;
			const latest = new Date(Date.parse(m.at) + INVITE_LIFETIME_MS).toISOString();
			const asked = m.expiresAt ? new Date(m.expiresAt).toISOString() : latest;
			await tables.invites.put([
				{
					id: m.inviteId,
					groupId: m.groupId,
					claimMemberId: m.claimMemberId,
					createdBy: userId,
					createdAt: m.at,
					expiresAt: asked < latest ? asked : latest,
					revokedAt: null,
					rowVersion: 0,
				},
			]);
			return;
		}
		case "invite.revoke": {
			const invite = await tables.invites.get(m.inviteId);
			if (invite && invite.groupId === m.groupId && !invite.revokedAt)
				await tables.invites.put([{ ...invite, revokedAt: m.at }]);
			return;
		}
		case "payment.record":
			return recordPayment(tables, m, userId);
		case "payment.confirm":
		case "payment.decline":
			return answerPayment(tables, m, userId);
		case "nudge.send": {
			if (await tables.nudges.get(m.nudgeId)) return;
			const me = await callerMember(tables, m.groupId, userId);
			const to = await tables.members.get(m.toMemberId);
			if (!me || !to || to.groupId !== m.groupId || to.id === me.id) return;
			if (!Number.isSafeInteger(m.amountCents) || m.amountCents <= 0) return;
			await tables.nudges.put([
				{
					id: m.nudgeId,
					groupId: m.groupId,
					fromMemberId: me.id,
					toMemberId: to.id,
					amountCents: m.amountCents,
					createdAt: m.at,
					rowVersion: 0,
				},
			]);
			return;
		}
		case "payment.undo": {
			const entry = await pendingPayment(tables, m.groupId, m.entryId);
			const me = await callerMember(tables, m.groupId, userId);
			if (entry && me && readPayment(entry, me.id)?.mayUndo)
				await tables.entries.put([
					{ ...entry, paymentStatus: "undone", closedAt: m.at, updatedByMemberId: me.id, updatedAt: m.at },
				]);
			return;
		}
	}
}

// private.is_stale: the bill moved past the version the change started from, and someone else (another
// member row; the same person on another device is not someone else) moved it. The server turns such a
// change into a conflict instead of applying it, so replaying it here would show an edit that won't happen.
async function isStale(tables: LocalTables, mutation: Mutation, userId: string) {
	if (mutation.type !== "entry.update" && mutation.type !== "entry.delete") return false;
	const entry = await tables.entries.get(mutation.entryId);
	if (!entry || entry.rowVersion <= mutation.baseVersion) return false;
	const me = await callerMember(tables, mutation.groupId, userId);
	return entry.updatedByMemberId !== me?.id;
}

async function dropGroup(tables: ReplicaRows, groupId: string) {
	const drop = async <K extends TableName>(name: K) => {
		const rows: Rows<RowOf<K>> = tables[name];
		await rows.delete((await rows.byGroup(groupId)).map((row) => rowKey(name, row)));
	};
	for (const name of TABLE_NAMES) await drop(name);
}

// A pull from version 0 holds every row of the group, so it is the whole truth: local rows it lacks are the
// effects of changes the server never applied (rejected ones included). Unsent changes are replayed after.
async function keepOnlyPulled(tables: ReplicaRows, change: GroupChanges) {
	const drop = async <K extends TableName>(name: K) => {
		const keep = keptAfterFullPull(name, change);
		if (!keep) return;
		const rows: Rows<RowOf<K>> = tables[name];
		const local = (await rows.byGroup(change.groupId)).map((row) => rowKey(name, row));
		await rows.delete(local.filter((key) => !keep.has(key)));
	};
	for (const name of TABLE_NAMES) await drop(name);
}

// Each row arrives whole (an entry with its items and shares) and replaces the local copy.
async function putPulled(tables: ReplicaRows, change: GroupChanges) {
	const put = async <K extends TableName>(name: K) => {
		const rows: Rows<RowOf<K>> = tables[name];
		await rows.put(pulledRows(name, change));
	};
	for (const name of TABLE_NAMES) await put(name);
	await tables.cursors.put([{ groupId: change.groupId, version: change.version }]);
}

// `pending` must be read in the same transaction as this merge, so changes made while the pull was
// in flight are replayed too.
// Returns a notice for each group dropped because this guest's name was taken back on another device.
export async function mergePull(
	tables: LocalTables,
	pull: PullResult,
	pending: Mutation[],
	userId: string
): Promise<MovedAwayNotice[]> {
	// Groups created here that haven't reached the server yet are missing from groupIds; keep them.
	const keep = new Set([...pull.groupIds, ...pending.flatMap((m) => (m.type === "group.create" ? [m.groupId] : []))]);
	const movedAway = new Set(pull.movedAway ?? []);
	const notices: MovedAwayNotice[] = [];
	for (const groupId of await tables.groupIds()) {
		if (keep.has(groupId)) continue;
		if (movedAway.has(groupId)) {
			const group = await tables.groups.get(groupId);
			const me = await callerMember(tables, groupId, userId);
			if (group && me?.role === "guest") notices.push({ groupId, groupName: group.name, displayName: me.displayName });
		}
		await dropGroup(tables, groupId);
	}

	for (const change of pull.changes) {
		const cursor = await tables.cursors.get(change.groupId);
		if (!cursor || cursor.version === 0) await keepOnlyPulled(tables, change);
		await putPulled(tables, change);
	}

	// Server rows just replaced the local copies; put this device's unsent changes back on top.
	for (const mutation of pending) {
		if (await isStale(tables, mutation, userId)) continue;
		await applyMutation(tables, mutation, userId);
	}
	return notices;
}
