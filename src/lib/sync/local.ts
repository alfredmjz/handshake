import { isCoverKey } from "@/lib/cover-colors";
import { isSticker } from "@/lib/cover-stickers";
import { computeShares } from "@/lib/ledger";
import type {
	BillFields,
	ConflictRow,
	CursorRow,
	EntryRow,
	GroupChanges,
	GroupRow,
	GuestCodeRow,
	InviteRow,
	InviteTokenRow,
	MemberRow,
	Mutation,
	MutationOf,
	NudgeRow,
	PullResult,
	Share,
} from "@/lib/sync/types";

export interface Rows<T> {
	get(id: string): Promise<T | undefined>;
	byGroup(groupId: string): Promise<T[]>;
	put(rows: T[]): Promise<void>;
	delete(ids: string[]): Promise<void>;
}

// The local tables sync reads and writes: Dexie in the app, plain maps in tests.
export interface LocalTables {
	groups: Rows<GroupRow>;
	members: Rows<MemberRow>;
	entries: Rows<EntryRow>;
	conflicts: Rows<ConflictRow>;
	invites: Rows<InviteRow>;
	inviteTokens: Rows<InviteTokenRow>;
	nudges: Rows<NudgeRow>;
	guestCodes: Rows<GuestCodeRow>;
	cursors: Rows<CursorRow>;
	groupIds(): Promise<string[]>;
}

// "<displayName> is now signed in on another device", for a group this device lost.
export type MovedAwayNotice = { groupId: string; groupName: string; displayName: string };

const INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

// The caller's active member row in the group, as private.caller_member finds it.
async function callerMember(tables: LocalTables, groupId: string, userId: string) {
	return (await tables.members.byGroup(groupId)).find((m) => m.userId === userId && !m.deletedAt);
}

// private.can_answer: still in the group, with a login.
function canAnswer(member: MemberRow | undefined) {
	return !!member && member.userId !== null && !member.deletedAt;
}

// private.payment_sides: the payer has paid cents, the receiver owed cents.
function paymentSides(entry: EntryRow) {
	return {
		from: entry.shares.find((s) => s.paidCents > 0)?.memberId,
		to: entry.shares.find((s) => s.owedCents > 0)?.memberId,
	};
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

// private.group_note: SQL's btrim trims spaces only; blank is no note.
function groupNote(note: string | null | undefined) {
	return note?.replace(/^ +| +$/g, "") || null;
}

async function pendingPayment(tables: LocalTables, groupId: string, entryId: string) {
	const entry = await tables.entries.get(entryId);
	return entry && entry.groupId === groupId && entry.kind === "payment" && entry.paymentStatus === "pending"
		? entry
		: undefined;
}

// private.hand_over: the full member who joined first becomes owner, or the group goes.
async function handOver(tables: LocalTables, groupId: string, at: string) {
	const heirs = (await tables.members.byGroup(groupId))
		.filter((m) => m.role === "member" && m.userId !== null && !m.deletedAt)
		.sort((a, b) => (a.joinedAt ?? "￿").localeCompare(b.joinedAt ?? "￿") || a.id.localeCompare(b.id));
	if (heirs.length > 0) {
		await tables.members.put([{ ...heirs[0], role: "owner" }]);
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

	// Only the payer needs the other side to agree; the receiver saying they were paid is enough.
	const otherCanAnswer = me.id === from.id ? canAnswer(to) : false;
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
			paymentStatus: otherCanAnswer ? "pending" : "confirmed",
			payerConfirmedAt: me.id === from.id ? m.at : null,
			receiverConfirmedAt: me.id === to.id ? m.at : null,
			confirmedAt: otherCanAnswer ? null : m.at,
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

	const sides = paymentSides(entry);
	const asPayer = me.id === sides.from && !entry.payerConfirmedAt;
	const asReceiver = !asPayer && me.id === sides.to && !entry.receiverConfirmedAt;
	if (!asPayer && !asReceiver) return;

	const answered = { ...entry, updatedByMemberId: me.id, updatedAt: m.at };
	if (m.type === "payment.confirm") {
		await tables.entries.put([
			{
				...answered,
				paymentStatus: "confirmed",
				payerConfirmedAt: asPayer ? m.at : entry.payerConfirmedAt,
				receiverConfirmedAt: asReceiver ? m.at : entry.receiverConfirmedAt,
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
		.filter((e) => e.paymentStatus === "pending" && e.shares.some((s) => s.memberId === target.id))
		.map((e) => ({
			...e,
			paymentStatus: "undone" as const,
			closedAt: m.at,
			updatedByMemberId: target.id,
			updatedAt: m.at,
		}));
	if (undone.length > 0) await tables.entries.put(undone);

	if (target.role === "owner") await handOver(tables, m.groupId, m.at);
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
					note: groupNote(m.note),
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
			if (group) await tables.groups.put([{ ...group, note: groupNote(m.note) }]);
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
			if (entry && me && entry.createdByMemberId === me.id)
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

async function dropGroup(tables: LocalTables, groupId: string) {
	const ids = async <T>(rows: Rows<T>, key: (row: T) => string) => (await rows.byGroup(groupId)).map(key);
	await tables.members.delete(await ids(tables.members, (r) => r.id));
	await tables.entries.delete(await ids(tables.entries, (r) => r.id));
	await tables.conflicts.delete(await ids(tables.conflicts, (r) => r.id));
	await tables.invites.delete(await ids(tables.invites, (r) => r.id));
	await tables.inviteTokens.delete(await ids(tables.inviteTokens, (r) => r.inviteId));
	await tables.nudges.delete(await ids(tables.nudges, (r) => r.id));
	await tables.guestCodes.delete(await ids(tables.guestCodes, (r) => r.memberId));
	await tables.cursors.delete([groupId]);
	await tables.groups.delete([groupId]);
}

// A pull from version 0 holds every row of the group, so it is the whole truth: local rows it lacks are the
// effects of changes the server never applied (rejected ones included). Unsent changes are replayed after.
async function keepOnlyPulled(tables: LocalTables, change: GroupChanges) {
	const drop = async <T extends { id: string }>(rows: Rows<T>, pulled: T[]) => {
		const keep = new Set(pulled.map((row) => row.id));
		await rows.delete((await rows.byGroup(change.groupId)).filter((row) => !keep.has(row.id)).map((row) => row.id));
	};
	await drop(tables.members, change.members);
	await drop(tables.entries, change.entries);
	await drop(tables.conflicts, change.conflicts);
	await drop(tables.invites, change.invites);
	await drop(tables.nudges, change.nudges);
	const codes = new Set(change.guestCodes.map((c) => c.memberId));
	await tables.guestCodes.delete(
		(await tables.guestCodes.byGroup(change.groupId)).filter((c) => !codes.has(c.memberId)).map((c) => c.memberId)
	);
	const invites = new Set(change.invites.map((invite) => invite.id));
	await tables.inviteTokens.delete(
		(await tables.inviteTokens.byGroup(change.groupId)).filter((t) => !invites.has(t.inviteId)).map((t) => t.inviteId)
	);
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
		await tables.groups.put(change.groups);
		await tables.members.put(change.members);
		// Each entry arrives whole, items and shares included, and replaces the local copy.
		await tables.entries.put(change.entries);
		await tables.conflicts.put(change.conflicts);
		await tables.invites.put(change.invites);
		await tables.nudges.put(change.nudges);
		await tables.guestCodes.put(change.guestCodes);
		await tables.cursors.put([{ groupId: change.groupId, version: change.version }]);
	}

	// Server rows just replaced the local copies; put this device's unsent changes back on top.
	for (const mutation of pending) {
		if (await isStale(tables, mutation, userId)) continue;
		await applyMutation(tables, mutation, userId);
	}
	return notices;
}
