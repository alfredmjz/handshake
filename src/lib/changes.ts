import { createContext, useContext } from "react";

import { computeShares, validateEntry, type Item, type LedgerMember, type Share } from "@/lib/ledger";
import type { LocalDb } from "@/lib/local-db";
import { allowedWhenCompleted, may, type Action, type Role } from "@/lib/permissions";
import { dexieTables, writeTables } from "@/lib/sync/dexie-store";
import { applyMutation, type LocalTables } from "@/lib/sync/local";
import type {
	BillFields,
	ConflictResolution,
	ConflictRow,
	EntryRow,
	GroupRow,
	InviteRow,
	MemberRow,
	Mutation,
} from "@/lib/sync/types";

// What a person asks to do (an intent) becomes a plan of mutations; commit() carries it out on this
// device. planChange mirrors every permission and validation rule push_changes() applies, with the
// server's codes, so the device refuses exactly what the server would (docs/architecture.md §9.4).

export type GroupState = {
	group: GroupRow;
	members: MemberRow[];
	entries: EntryRow[];
	conflicts: ConflictRow[];
	invites: InviteRow[];
	// The caller's active member row; null when they aren't in the group (any more).
	me: { memberId: string; userId: string; role: Role } | null;
};

// A bill as the editor holds it; the amount and shares are worked out from the items.
export type ExpenseDraft = { description: string; entryDate: string; notes: string | null; items: Item[] };

export type GroupIntent =
	| { type: "renameGroup"; name: string }
	| { type: "deleteGroup" }
	| { type: "addPerson"; displayName: string }
	| { type: "renamePerson"; memberId: string; displayName: string }
	// Yourself = leave.
	| { type: "removePerson"; memberId: string }
	| { type: "addExpense"; draft: ExpenseDraft }
	| { type: "editExpense"; entryId: string; draft: ExpenseDraft }
	| { type: "recordPayment"; from: string; to: string; amountCents: number; entryDate: string; notes: string | null }
	| { type: "confirmPayment"; entryId: string }
	| { type: "declinePayment"; entryId: string; note: string | null }
	| { type: "undoPayment"; entryId: string }
	| { type: "deleteEntry"; entryId: string }
	| { type: "resolveConflict"; conflictId: string; resolution: ConflictResolution; final: ExpenseDraft | "deleted" }
	| { type: "completeGroup" }
	| { type: "reopenGroup" }
	| { type: "createInvite"; claimMemberId: string | null }
	| { type: "revokeInvite"; inviteId: string };

export type Intent = { type: "createGroup"; name: string; displayName: string } | ({ groupId: string } & GroupIntent);

export type Refusal = { ok: false; code: "HS403" | "HS409" | "HS422"; reason: string };

// createdId: the new group, person, entry or invite.
export type Plan = { ok: true; mutations: Mutation[]; createdId: string | null } | Refusal;

export type PlanContext = {
	newId(): string;
	randomToken(): string;
	now: string;
	today: string;
	// Guests can't create groups: an account rule outside the matrix.
	isAnonymous: boolean;
};

const INVITE_DAYS = 14;

type MutationBody = Mutation extends infer M ? (M extends Mutation ? Omit<M, "id" | "at"> : never) : never;

class Refused extends Error {
	constructor(readonly refusal: Refusal) {
		super(refusal.reason);
	}
}

function refuse(code: Refusal["code"], reason: string): never {
	throw new Refused({ ok: false, code, reason });
}

const canAnswer = (member: MemberRow) => member.userId !== null && !member.deletedAt;

function checkName(value: string, max: number, what: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 1 || trimmed.length > max) refuse("HS422", `${what} must be 1 to ${max} characters`);
	return trimmed;
}

// The device's private.require(): an active member of a live group, allowed in a completed one, and
// allowed by the matrix.
function need(
	state: GroupState | null,
	action: Action
): asserts state is GroupState & { me: NonNullable<GroupState["me"]> } {
	if (!state || !state.me) return refuse("HS403", "You are not a member of this group");
	if (state.group.deletedAt) refuse("HS403", "This group was deleted");
	if (state.group.completedAt && !allowedWhenCompleted(action)) refuse("HS403", "This group is completed");
	if (!may(action, state.me.role)) {
		refuse(
			"HS403",
			may(action, "owner") && !may(action, "member") ? "Only the group's owner can do that" : "Guests can't do that"
		);
	}
}

const ledgerMembers = (state: GroupState): LedgerMember[] =>
	state.members.map((member) => ({ id: member.id, displayName: member.displayName, hasLogin: member.userId !== null }));

// A bill's fields from the editor's draft, checked like entry.create on the server.
function billFrom(state: GroupState, draft: ExpenseDraft): BillFields {
	const items = Array.isArray(draft.items) ? draft.items : [];
	let shares: Share[] = [];
	try {
		shares = computeShares(items);
	} catch {
		// Malformed items: validateEntry says what's wrong.
	}
	const bill: BillFields = {
		description: typeof draft.description === "string" ? draft.description.trim() : draft.description,
		amountCents: items.reduce((total, item) => total + (item?.amountCents ?? 0), 0),
		entryDate: draft.entryDate,
		notes: draft.notes,
		items,
		shares,
	};
	const problems = validateEntry({ kind: "expense", ...bill }, ledgerMembers(state));
	if (problems.length > 0) refuse("HS422", problems[0].reason);
	return bill;
}

function entryIn(state: GroupState, entryId: string, what = "entry"): EntryRow {
	return state.entries.find((entry) => entry.id === entryId) ?? refuse("HS422", `That ${what} isn't in this group`);
}

function memberIn(state: GroupState, memberId: string): MemberRow {
	return state.members.find((member) => member.id === memberId) ?? refuse("HS422", "That person is not in this group");
}

function plan(
	state: GroupState | null,
	intent: Intent,
	ctx: PlanContext
): { mutations: MutationBody[]; createdId?: string } {
	if (intent.type === "createGroup") {
		if (ctx.isAnonymous) refuse("HS403", "Guests can't create groups");
		const groupId = ctx.newId();
		return {
			createdId: groupId,
			mutations: [
				{
					type: "group.create",
					groupId,
					memberId: ctx.newId(),
					name: checkName(intent.name, 80, "A group's name"),
					displayName: checkName(intent.displayName, 60, "Your name"),
				},
			],
		};
	}

	const groupId = intent.groupId;
	switch (intent.type) {
		case "renameGroup":
			need(state, "group.rename");
			return { mutations: [{ type: "group.rename", groupId, name: checkName(intent.name, 80, "A group's name") }] };

		case "deleteGroup":
			need(state, "group.delete");
			return { mutations: [{ type: "group.delete", groupId }] };

		case "completeGroup":
			need(state, "group.complete");
			return { mutations: [{ type: "group.complete", groupId }] };

		case "reopenGroup":
			need(state, "group.reopen");
			return { mutations: state.group.completedAt ? [{ type: "group.reopen", groupId }] : [] };

		case "addPerson": {
			need(state, "member.add");
			const memberId = ctx.newId();
			const displayName = checkName(intent.displayName, 60, "A name");
			return { createdId: memberId, mutations: [{ type: "member.add", groupId, memberId, displayName }] };
		}

		case "renamePerson": {
			need(state, intent.memberId === state?.me?.memberId ? "member.rename.self" : "member.rename.others");
			memberIn(state, intent.memberId);
			const displayName = checkName(intent.displayName, 60, "A name");
			return { mutations: [{ type: "member.rename", groupId, memberId: intent.memberId, displayName }] };
		}

		case "removePerson": {
			need(state, intent.memberId === state?.me?.memberId ? "member.remove.self" : "member.remove.others");
			const target = memberIn(state, intent.memberId);
			return { mutations: target.deletedAt ? [] : [{ type: "member.remove", groupId, memberId: target.id }] };
		}

		case "addExpense": {
			need(state, "entry.create");
			const entryId = ctx.newId();
			return {
				createdId: entryId,
				mutations: [{ type: "entry.create", groupId, entryId, ...billFrom(state, intent.draft) }],
			};
		}

		case "editExpense": {
			need(state, "entry.update");
			const entry = entryIn(state, intent.entryId);
			if (entry.kind === "payment")
				refuse("HS422", "A payment can't be edited or deleted; record one the other way instead");
			const bill = billFrom(state, intent.draft);
			return {
				mutations: [{ type: "entry.update", groupId, entryId: entry.id, baseVersion: entry.rowVersion, ...bill }],
			};
		}

		case "deleteEntry": {
			const existing = state?.entries.find((entry) => entry.id === intent.entryId);
			need(
				state,
				!existing || existing.createdByMemberId === state?.me?.memberId ? "entry.delete.own" : "entry.delete.others"
			);
			const entry = entryIn(state, intent.entryId);
			if (entry.kind === "payment")
				refuse("HS422", "A payment can't be edited or deleted; record one the other way instead");
			return {
				mutations: entry.deletedAt
					? []
					: [{ type: "entry.delete", groupId, entryId: entry.id, baseVersion: entry.rowVersion }],
			};
		}

		case "resolveConflict": {
			need(state, "conflict.resolve");
			const conflict =
				state.conflicts.find((row) => row.id === intent.conflictId) ??
				refuse("HS422", "That conflict isn't in this group");
			if (conflict.resolvedAt) {
				const resolver = state.members.find((member) => member.id === conflict.resolvedByMemberId);
				refuse("HS409", `${resolver?.displayName ?? "Someone"} already resolved this`);
			}
			if (!["kept_current", "took_proposed", "merged"].includes(intent.resolution)) {
				refuse("HS422", "resolution must be kept_current, took_proposed or merged");
			}
			return {
				mutations: [
					{
						type: "conflict.resolve",
						groupId,
						conflictId: conflict.id,
						entryId: conflict.entryId,
						resolution: intent.resolution,
						entry: intent.final === "deleted" ? { deleted: true } : billFrom(state, intent.final),
					},
				],
			};
		}

		case "createInvite": {
			need(state, "invite.create");
			if (intent.claimMemberId !== null) {
				const claim = state.members.find((member) => member.id === intent.claimMemberId);
				if (!claim || claim.userId !== null || claim.deletedAt) {
					refuse("HS422", "An invite can only be for someone in this group who hasn't joined");
				}
			}
			const inviteId = ctx.newId();
			const expiresAt = new Date(Date.parse(ctx.now) + INVITE_DAYS * 86_400_000).toISOString();
			return {
				createdId: inviteId,
				mutations: [
					{
						type: "invite.create",
						groupId,
						inviteId,
						token: ctx.randomToken(),
						claimMemberId: intent.claimMemberId,
						expiresAt,
					},
				],
			};
		}

		case "revokeInvite": {
			const existing = state?.invites.find((invite) => invite.id === intent.inviteId);
			need(state, !existing || existing.createdBy === state?.me?.userId ? "invite.revoke.own" : "invite.revoke.others");
			const invite =
				state.invites.find((row) => row.id === intent.inviteId) ?? refuse("HS422", "That invite isn't in this group");
			return { mutations: invite.revokedAt ? [] : [{ type: "invite.revoke", groupId, inviteId: invite.id }] };
		}

		case "recordPayment":
			return recordPayment(state, intent, ctx);

		case "confirmPayment":
		case "declinePayment":
		case "undoPayment":
			return answerPayment(state, intent);
	}
}

function recordPayment(
	state: GroupState | null,
	intent: Extract<Intent, { type: "recordPayment" }>,
	ctx: PlanContext
): { mutations: MutationBody[]; createdId: string } {
	const mine = state?.me && [intent.from, intent.to].includes(state.me.memberId);
	need(state, mine ? "payment.record.own" : "payment.record.others");

	const from = state.members.find((member) => member.id === intent.from);
	const to = state.members.find((member) => member.id === intent.to);
	if (!from || !to) return refuse("HS422", "Both sides of a payment must be in this group");
	if (from!.id === to!.id) refuse("HS422", "A payment is between two different people");
	if (!mine && (canAnswer(from!) || canAnswer(to!))) {
		refuse("HS422", "You can only record payments between two people who can't answer them themselves");
	}

	const entryId = ctx.newId();
	const problems = validateEntry(
		{
			kind: "payment",
			description: "",
			amountCents: intent.amountCents,
			entryDate: intent.entryDate,
			notes: intent.notes,
			items: null,
			shares:
				Number.isSafeInteger(intent.amountCents) && intent.amountCents > 0
					? computeShares([{ id: entryId, amountCents: intent.amountCents, paidBy: from!.id, splitAmong: [to!.id] }])
					: [],
		},
		ledgerMembers(state)
	);
	if (problems.length > 0) refuse("HS422", problems[0].reason);

	const pair = new Set([from!.id, to!.id]);
	const waiting = state.entries.some(
		(entry) =>
			entry.paymentStatus === "pending" && entry.shares.filter((share) => pair.has(share.memberId)).length === 2
	);
	if (waiting) refuse("HS409", "A payment between these two is already waiting for an answer");

	return {
		createdId: entryId,
		mutations: [
			{
				type: "payment.record",
				groupId: state.group.id,
				entryId,
				fromMemberId: from!.id,
				toMemberId: to!.id,
				amountCents: intent.amountCents,
				entryDate: intent.entryDate,
				notes: intent.notes,
			},
		],
	};
}

// Only the side that hasn't agreed may confirm or decline; only the starter may undo. Answering the
// same way twice (a double tap) plans nothing; a payment someone else has answered gives HS409.
function answerPayment(
	state: GroupState | null,
	intent: Extract<Intent, { type: "confirmPayment" | "declinePayment" | "undoPayment" }>
): { mutations: MutationBody[] } {
	need(state, intent.type === "undoPayment" ? "payment.undo" : "payment.respond");
	const entry = entryIn(state, intent.entryId, "payment");
	if (entry.kind !== "payment") refuse("HS422", "That is a bill, not a payment");
	const me = state.me.memberId;

	if (entry.paymentStatus !== "pending") {
		const already =
			entry.updatedByMemberId === me &&
			((intent.type === "confirmPayment" && entry.paymentStatus === "confirmed") ||
				(intent.type === "declinePayment" && entry.paymentStatus === "declined") ||
				(intent.type === "undoPayment" && entry.paymentStatus === "undone"));
		if (already) return { mutations: [] };
		const answeredBy = state.members.find((member) => member.id === entry.updatedByMemberId)?.displayName ?? "Someone";
		refuse(
			"HS409",
			entry.paymentStatus === "undone"
				? `${answeredBy} undid this payment`
				: `${answeredBy} already answered this payment`
		);
	}

	const groupId = state.group.id;
	if (intent.type === "undoPayment") {
		if (entry.createdByMemberId !== me) refuse("HS403", "Only whoever recorded this payment can undo it");
		return { mutations: [{ type: "payment.undo", groupId, entryId: entry.id }] };
	}

	const from = entry.shares.find((share) => share.paidCents > 0)?.memberId;
	const to = entry.shares.find((share) => share.owedCents > 0)?.memberId;
	const mySideWaits = (me === from && !entry.payerConfirmedAt) || (me === to && !entry.receiverConfirmedAt);
	if (!mySideWaits) refuse("HS403", "Only the other side of this payment can answer it");

	if (intent.type === "confirmPayment") return { mutations: [{ type: "payment.confirm", groupId, entryId: entry.id }] };
	const note = intent.note?.trim() || null;
	if (note !== null && note.length > 200) refuse("HS422", "A note must be at most 200 characters");
	return { mutations: [{ type: "payment.decline", groupId, entryId: entry.id, note }] };
}

// Pure: the same state, intent and context always give the same plan. Refusals are returned, not thrown.
export function planChange(state: GroupState | null, intent: Intent, ctx: PlanContext): Plan {
	try {
		const { mutations, createdId } = plan(state, intent, ctx);
		return {
			ok: true,
			mutations: mutations.map((body) => ({ id: ctx.newId(), at: ctx.now, ...body }) as Mutation),
			createdId: createdId ?? null,
		};
	} catch (error) {
		if (error instanceof Refused) return error.refusal;
		throw error;
	}
}

// ---------------------------------------------------------------------------
// commit: the only local writer
// ---------------------------------------------------------------------------

export type Commit = (intent: Intent) => Promise<Plan>;

export type CommitterDeps = {
	db: LocalDb;
	userId: string;
	isAnonymous: boolean;
	requestSync(): void;
	newId(): string;
	randomToken(): string;
	now(): Date;
};

async function readGroupState(tables: LocalTables, groupId: string, userId: string): Promise<GroupState | null> {
	const group = await tables.groups.get(groupId);
	if (!group) return null;
	const [members, entries, conflicts, invites] = await Promise.all([
		tables.members.byGroup(groupId),
		tables.entries.byGroup(groupId),
		tables.conflicts.byGroup(groupId),
		tables.invites.byGroup(groupId),
	]);
	const mine = members.find((member) => member.userId === userId && !member.deletedAt);
	return {
		group,
		members,
		entries,
		conflicts,
		invites,
		me: mine ? { memberId: mine.id, userId, role: mine.role } : null,
	};
}

const localDate = (date: Date) =>
	`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

// One read-write transaction: read the group, plan, then apply and queue each mutation in order. Two quick
// taps can't both plan against the same state. Storage failures throw and roll everything back.
export function createCommitter(deps: CommitterDeps): Commit {
	const { db, userId } = deps;
	return async (intent) => {
		const at = deps.now();
		const ctx: PlanContext = {
			newId: deps.newId,
			randomToken: deps.randomToken,
			now: at.toISOString(),
			today: localDate(at),
			isAnonymous: deps.isAnonymous,
		};
		const result = await db.transaction("rw", writeTables(db), async () => {
			const tables = dexieTables(db);
			const state = intent.type === "createGroup" ? null : await readGroupState(tables, intent.groupId, userId);
			const planned = planChange(state, intent, ctx);
			if (!planned.ok) return planned;
			for (const mutation of planned.mutations) {
				await applyMutation(tables, mutation, userId);
				await db.outbox.add({ id: mutation.id, mutation });
			}
			return planned;
		});
		if (result.ok && result.mutations.length > 0) deps.requestSync();
		return result;
	};
}

const CommitContext = createContext<Commit | null>(null);

export const CommitProvider = CommitContext.Provider;

export function useCommit(): Commit {
	const commit = useContext(CommitContext);
	if (!commit) throw new Error("useCommit must be used inside the signed-in layout");
	return commit;
}
