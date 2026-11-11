import { createContext, useContext } from "react";

import { isCategory } from "@/lib/categories";
import { computeShares, validateEntry, type Item, type LedgerMember } from "@/lib/ledger";
import type { LocalDb } from "@/lib/local-db";
import { currentDebt, lastNudge, nudgedRecently } from "@/lib/nudge-view";
import { allowedWhenCompleted, may, type Action } from "@/lib/permissions";
import { dexieTables, writeTables } from "@/lib/sync/dexie-store";
import { applyMutation } from "@/lib/sync/local";
import type {
	BillFields,
	Category,
	ConflictResolution,
	ConflictRow,
	EntryRow,
	GroupRow,
	MemberRow,
	Mutation,
	NudgeRow,
	Role,
} from "@/lib/sync/types";

export type GroupState = {
	group: GroupRow;
	members: MemberRow[];
	entries: EntryRow[];
	conflicts: ConflictRow[];
	// Only the nudge intent reads it; missing is none.
	nudges?: NudgeRow[];
	me: { memberId: string; role: Role; isAnonymous: boolean };
};

// What a bill editor holds. The amount is the items' total and the shares come from computeShares.
export type ExpenseDraft = {
	description: string;
	entryDate: string;
	notes: string | null;
	category: Category | null;
	items: Item[];
};

export type GroupIntent =
	| { type: "renameGroup"; name: string }
	// null or blank clears the note.
	| { type: "describeGroup"; note: string | null }
	| { type: "deleteGroup" }
	| { type: "addPerson"; displayName: string }
	| { type: "renamePerson"; memberId: string; displayName: string }
	| { type: "removePerson"; memberId: string } // yourself = leave
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
	// Owner only: a new group code from the server; the old one stops working.
	| { type: "resetGroupCode" }
	// memberId: the person who owes me; the amount is what they owe me now.
	| { type: "nudge"; memberId: string };

export type Intent =
	| { type: "createGroup"; name: string; displayName: string; note?: string | null }
	| ({ groupId: string } & GroupIntent);

export type RefusalCode = "HS403" | "HS409" | "HS422";

export type Plan =
	// createdId: the new group, person, entry or nudge.
	{ ok: true; mutations: Mutation[]; createdId: string | null } | { ok: false; code: RefusalCode; reason: string };

export type PlanContext = {
	newId(): string;
	now: string;
	today: string;
	// group.create checks the account, not a group role.
	isAnonymous: boolean;
};

const MAX_CENTS = 1_000_000_000_000;

type MutationBody = Mutation extends infer M ? (M extends Mutation ? Omit<M, "id" | "at"> : never) : never;

const refuse = (code: RefusalCode, reason: string): Plan => ({ ok: false, code, reason });
const nothing: Plan = { ok: true, mutations: [], createdId: null };

// private.can_answer: still in the group, with a login.
export function canAnswer(member: MemberRow | undefined): boolean {
	return !!member && member.userId !== null && !member.deletedAt;
}

// private.payment_sides: the payer has paid cents, the receiver owed cents.
export function paymentSides(entry: EntryRow): { from: string | undefined; to: string | undefined } {
	return {
		from: entry.shares.find((s) => s.paidCents > 0)?.memberId,
		to: entry.shares.find((s) => s.owedCents > 0)?.memberId,
	};
}

// The payment waiting for an answer between two people, either way round.
export function pendingPaymentBetween(entries: EntryRow[], a: string, b: string): EntryRow | undefined {
	return entries.find(
		(e) =>
			e.kind === "payment" &&
			e.paymentStatus === "pending" &&
			e.shares.some((s) => s.memberId === a) &&
			e.shares.some((s) => s.memberId === b)
	);
}

// Whether a payment recorded by me between these two counts at once (no one to ask) rather than waiting.
export function paymentCountsAtOnce(state: GroupState, from: string, to: string): boolean {
	const member = (id: string) => state.members.find((m) => m.id === id);
	if (state.me.memberId === from) return !canAnswer(member(to));
	if (state.me.memberId === to) return !canAnswer(member(from));
	return true;
}

export function toLedgerMembers(members: MemberRow[]): LedgerMember[] {
	return members.map((m) => ({ id: m.id, displayName: m.displayName, hasLogin: m.userId !== null }));
}

// Postgres char_length counts code points, not UTF-16 units.
function charLength(text: string) {
	return [...text].length;
}

function nameLength(name: string) {
	return charLength(name.trim());
}

// What SQL's btrim + NULLIF(…, '') stores: spaces only are trimmed, blank is no note.
function storedNote(note: string | null) {
	const trimmed = note?.replace(/^ +| +$/g, "") ?? "";
	return trimmed === "" ? null : trimmed;
}

function isCents(value: number, min: number) {
	return Number.isInteger(value) && value >= min && value <= MAX_CENTS;
}

function isRealDate(date: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
	const [y, m, d] = date.split("-").map(Number);
	// Postgres has no year 0; setUTCFullYear keeps years 1-99 as written (Date.UTC maps them to 1900s).
	if (y < 1) return false;
	const parsed = new Date(0);
	parsed.setUTCFullYear(y, m - 1, d);
	return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

// computeShares' precondition; when it fails validateEntry names the problem with the items.
function itemsWellFormed(items: Item[]) {
	return (
		items.length > 0 &&
		items.every(
			(i) =>
				Number.isSafeInteger(i.amountCents) &&
				i.amountCents > 0 &&
				i.splitAmong.length > 0 &&
				new Set(i.splitAmong).size === i.splitAmong.length
		)
	);
}

// The bill entry.create / entry.update / conflict.resolve carry, or the first HS422 problem with it.
function billFields(draft: ExpenseDraft, members: MemberRow[]): BillFields | Plan {
	const items = draft.items;
	const computable = itemsWellFormed(items);
	const fields: BillFields = {
		description: draft.description.trim(),
		amountCents: items.reduce((total, item) => total + item.amountCents, 0),
		entryDate: draft.entryDate,
		notes: draft.notes?.trim() ? draft.notes : null,
		category: draft.category ?? null,
		items,
		shares: computable ? computeShares(items) : [],
	};
	const problems = validateEntry({ kind: "expense", ...fields }, toLedgerMembers(members)).filter(
		(p) => computable || !p.field.startsWith("shares")
	);
	if (problems.length > 0) return refuse("HS422", problems[0].reason);
	// private.entry_category runs after the bill checks.
	if (fields.category !== null && !isCategory(fields.category))
		return refuse("HS422", "The category must be food, drinks, stay, travel, groceries or fun");
	return fields;
}

function isPlan(value: BillFields | Plan): value is Plan {
	return "ok" in value;
}

// private.require: active member, group not deleted, completed check, then the matrix.
function check(state: GroupState | null, action: Action): Plan | null {
	if (!state) return refuse("HS403", "You are not a member of this group");
	if (state.group.deletedAt) return refuse("HS403", "This group was deleted");
	if (state.group.completedAt && !allowedWhenCompleted(action)) return refuse("HS403", "This group is completed");
	if (!may(action, state.me.role)) {
		return refuse(
			"HS403",
			may(action, "owner") && !may(action, "member") ? "Only the group's owner can do this" : "Guests can't do this"
		);
	}
	return null;
}

const groupNameProblem = (name: string) =>
	nameLength(name) < 1 || nameLength(name) > 80 ? refuse("HS422", "A group name must be 1 to 80 characters") : null;
// private.group_note: checked on the stored (trimmed) note.
const groupNoteProblem = (note: string | null) => {
	const stored = storedNote(note);
	return stored !== null && charLength(stored) > 120
		? refuse("HS422", "A group note must be at most 120 characters")
		: null;
};
const displayNameProblem = (name: string) =>
	nameLength(name) < 1 || nameLength(name) > 60 ? refuse("HS422", "A name must be 1 to 60 characters") : null;

// private.require_unique_name: names are unique among the group's active people, ignoring case and outer spaces.
export function isNameTaken(members: MemberRow[], name: string, exceptMemberId: string | null = null): boolean {
	const key = name.trim().toLowerCase();
	return members.some((m) => !m.deletedAt && m.id !== exceptMemberId && m.displayName.trim().toLowerCase() === key);
}

const nameClash = (name: string) => refuse("HS409", `${name.trim()} is already in this group`);

// Turns what a person asks for into the mutations that do it, in apply order, or the refusal push_changes
// would give (same code, same order of checks). Pure: everything it needs is in its arguments.
export function planChange(state: GroupState | null, intent: Intent, ctx: PlanContext): Plan {
	const at = ctx.now;
	const one = (body: MutationBody, createdId: string | null = null): Plan => ({
		ok: true,
		mutations: [{ id: ctx.newId(), at, ...body }],
		createdId,
	});

	if (intent.type === "createGroup") {
		if (ctx.isAnonymous) return refuse("HS403", "Guests can't create groups");
		const note = intent.note ?? null;
		const noteProblem = groupNoteProblem(note);
		if (noteProblem) return noteProblem;
		const problem = groupNameProblem(intent.name);
		if (problem) return problem;
		// The server would fall back to the profile name for a blank one, but this device would show "" until
		// the pull; refusing it is the smaller surprise (callers pass defaultDisplayName).
		const nameProblem = displayNameProblem(intent.displayName);
		if (nameProblem) return nameProblem;
		const groupId = ctx.newId();
		const memberId = ctx.newId();
		return one(
			{
				type: "group.create",
				groupId,
				memberId,
				name: intent.name.trim(),
				displayName: intent.displayName.trim(),
				note: storedNote(note),
			},
			groupId
		);
	}

	const groupId = intent.groupId;
	const me = state?.me.memberId;
	const member = (id: string) => state?.members.find((m) => m.id === id);
	const entry = (id: string) => state?.entries.find((e) => e.id === id);

	switch (intent.type) {
		case "renameGroup":
			return (
				check(state, "group.rename") ??
				groupNameProblem(intent.name) ??
				one({ type: "group.rename", groupId, name: intent.name.trim() })
			);
		case "describeGroup":
			return (
				check(state, "group.rename") ??
				groupNoteProblem(intent.note) ??
				one({ type: "group.describe", groupId, note: storedNote(intent.note) })
			);
		case "deleteGroup":
			return check(state, "group.delete") ?? one({ type: "group.delete", groupId });
		case "completeGroup":
			return check(state, "group.complete") ?? one({ type: "group.complete", groupId });
		case "reopenGroup":
			return (
				check(state, "group.reopen") ?? (state!.group.completedAt ? one({ type: "group.reopen", groupId }) : nothing)
			);
		case "resetGroupCode":
			return check(state, "group.recode") ?? one({ type: "group.recode", groupId });

		case "addPerson": {
			const refused = check(state, "member.add") ?? displayNameProblem(intent.displayName);
			if (refused) return refused;
			if (isNameTaken(state!.members, intent.displayName)) return nameClash(intent.displayName);
			const memberId = ctx.newId();
			return one({ type: "member.add", groupId, memberId, displayName: intent.displayName.trim() }, memberId);
		}
		case "renamePerson": {
			const refused = check(state, intent.memberId === me ? "member.rename.self" : "member.rename.others");
			if (refused) return refused;
			const target = member(intent.memberId);
			if (!target) return refuse("HS422", "That person is not in this group");
			const renamed = target.displayName.trim().toLowerCase() !== intent.displayName.trim().toLowerCase();
			return (
				displayNameProblem(intent.displayName) ??
				(renamed && isNameTaken(state!.members, intent.displayName, target.id)
					? nameClash(intent.displayName)
					: null) ??
				one({ type: "member.rename", groupId, memberId: intent.memberId, displayName: intent.displayName.trim() })
			);
		}
		case "removePerson": {
			const refused = check(state, intent.memberId === me ? "member.remove.self" : "member.remove.others");
			if (refused) return refused;
			const target = member(intent.memberId);
			if (!target) return refuse("HS422", "That person is not in this group");
			if (target.deletedAt) return nothing;
			return one({ type: "member.remove", groupId, memberId: target.id });
		}

		case "addExpense": {
			const refused = check(state, "entry.create");
			if (refused) return refused;
			const fields = billFields(intent.draft, state!.members);
			if (isPlan(fields)) return fields;
			const entryId = ctx.newId();
			return one({ type: "entry.create", groupId, entryId, ...fields }, entryId);
		}
		case "editExpense": {
			const refused = check(state, "entry.update");
			if (refused) return refused;
			const stored = entry(intent.entryId);
			if (!stored) return nothing;
			if (stored.kind === "payment")
				return refuse("HS422", "A payment can't be edited or deleted; record one the other way instead");
			const fields = billFields(intent.draft, state!.members);
			if (isPlan(fields)) return fields;
			return one({ type: "entry.update", groupId, entryId: stored.id, baseVersion: stored.rowVersion, ...fields });
		}
		case "deleteEntry": {
			// Who added it decides the action; an entry this device doesn't have is checked as your own.
			const stored = entry(intent.entryId);
			const refused = check(
				state,
				!stored || stored.createdByMemberId === me ? "entry.delete.own" : "entry.delete.others"
			);
			if (refused) return refused;
			if (!stored) return nothing;
			if (stored.kind === "payment")
				return refuse("HS422", "A payment can't be edited or deleted; record one the other way instead");
			if (stored.deletedAt) return nothing;
			return one({ type: "entry.delete", groupId, entryId: stored.id, baseVersion: stored.rowVersion });
		}
		case "resolveConflict": {
			const refused = check(state, "conflict.resolve");
			if (refused) return refused;
			const conflict = state!.conflicts.find((c) => c.id === intent.conflictId);
			if (!conflict) return refuse("HS422", "That conflict doesn't exist in this group");
			if (conflict.resolvedAt) {
				const by = conflict.resolvedByMemberId ? member(conflict.resolvedByMemberId)?.displayName : undefined;
				return refuse("HS409", `${by ?? "Someone"} already resolved this`);
			}
			let final: BillFields | { deleted: true } = { deleted: true };
			if (intent.final !== "deleted") {
				const fields = billFields(intent.final, state!.members);
				if (isPlan(fields)) return fields;
				final = fields;
			}
			return one({
				type: "conflict.resolve",
				groupId,
				conflictId: conflict.id,
				entryId: conflict.entryId,
				resolution: intent.resolution,
				entry: final,
			});
		}

		case "recordPayment": {
			const own = intent.from === me || intent.to === me;
			const refused = check(state, own ? "payment.record.own" : "payment.record.others");
			if (refused) return refused;
			const from = member(intent.from);
			const to = member(intent.to);
			if (!from || !to) return refuse("HS422", "Both sides of a payment must be in this group");
			if (from.id === to.id) return refuse("HS422", "A payment is between two different people");
			if (!own && (canAnswer(from) || canAnswer(to)))
				return refuse("HS422", "You can only record payments between two people who can't answer them themselves");
			if (!isCents(intent.amountCents, 1))
				return refuse("HS422", "The amount must be a whole number of cents from 1 to 10^12");
			if (!/^\d{4}-\d{2}-\d{2}$/.test(intent.entryDate)) return refuse("HS422", "The date must be YYYY-MM-DD");
			if (!isRealDate(intent.entryDate)) return refuse("HS422", "The date must be a real day");
			if (intent.notes !== null && charLength(intent.notes) > 1000)
				return refuse("HS422", "Notes must be text of at most 1000 characters");
			if (pendingPaymentBetween(state!.entries, from.id, to.id))
				return refuse("HS409", "A payment between these two is already waiting for an answer");
			const entryId = ctx.newId();
			return one(
				{
					type: "payment.record",
					groupId,
					entryId,
					fromMemberId: from.id,
					toMemberId: to.id,
					amountCents: intent.amountCents,
					entryDate: intent.entryDate,
					notes: intent.notes?.trim() ? intent.notes : null,
				},
				entryId
			);
		}
		case "confirmPayment":
		case "declinePayment": {
			const refused = check(state, "payment.respond");
			if (refused) return refused;
			const payment = entry(intent.entryId);
			if (!payment) return nothing;
			if (payment.kind !== "payment") return refuse("HS422", "That is a bill, not a payment");
			// Answered already (here or by the other side): a second tap does nothing.
			if (payment.paymentStatus !== "pending") return nothing;
			const sides = paymentSides(payment);
			const mayAnswer =
				(me === sides.from && !payment.payerConfirmedAt) || (me === sides.to && !payment.receiverConfirmedAt);
			if (!mayAnswer) return refuse("HS403", "Only the other side of this payment can answer it");
			if (intent.type === "confirmPayment") return one({ type: "payment.confirm", groupId, entryId: payment.id });
			if (intent.note !== null && charLength(intent.note) > 200)
				return refuse("HS422", "A note must be text of at most 200 characters");
			return one({ type: "payment.decline", groupId, entryId: payment.id, note: storedNote(intent.note) });
		}
		case "undoPayment": {
			const refused = check(state, "payment.undo");
			if (refused) return refused;
			const payment = entry(intent.entryId);
			if (!payment) return nothing;
			if (payment.kind !== "payment") return refuse("HS422", "That is a bill, not a payment");
			if (payment.paymentStatus !== "pending") return nothing;
			if (payment.createdByMemberId !== me) return refuse("HS403", "Only whoever recorded this payment can undo it");
			return one({ type: "payment.undo", groupId, entryId: payment.id });
		}

		case "nudge": {
			const refused = check(state, "nudge.send");
			if (refused) return refused;
			const target = member(intent.memberId);
			if (!target) return refuse("HS422", "That person is not in this group");
			if (target.id === me) return refuse("HS422", "You can't nudge yourself");
			if (target.deletedAt) return refuse("HS422", `${target.displayName} left the group`);
			if (!canAnswer(target)) return refuse("HS422", `${target.displayName} hasn't joined`);
			const amountCents = currentDebt(state!.entries, toLedgerMembers(state!.members), target.id, me!);
			if (amountCents <= 0) return refuse("HS422", `${target.displayName} doesn't owe you anything`);
			if (nudgedRecently(lastNudge(state!.nudges ?? [], me!, target.id), at))
				return refuse("HS409", `You nudged ${target.displayName} today`);
			const nudgeId = ctx.newId();
			return one({ type: "nudge.send", groupId, nudgeId, toMemberId: target.id, amountCents }, nudgeId);
		}
	}
}

function localDate(date: Date) {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The group as planChange sees it, or null when this person isn't an active member of it here.
async function readGroupState(db: LocalDb, groupId: string, userId: string, isAnonymous: boolean) {
	const group = await db.groups.get(groupId);
	if (!group) return null;
	const members = await db.members.where("groupId").equals(groupId).toArray();
	const mine = members.find((m) => m.userId === userId && !m.deletedAt);
	if (!mine) return null;
	const [entries, conflicts, nudges] = await Promise.all([
		db.entries.where("groupId").equals(groupId).toArray(),
		db.conflicts.where("groupId").equals(groupId).toArray(),
		db.nudges.where("groupId").equals(groupId).toArray(),
	]);
	const state: GroupState = {
		group,
		members,
		entries,
		conflicts,
		nudges,
		me: { memberId: mine.id, role: mine.role, isAnonymous },
	};
	return state;
}

export type Commit = (intent: Intent) => Promise<Plan>;

export type CommitterDeps = {
	db: LocalDb;
	userId: string;
	isAnonymous: boolean;
	requestSync(): void;
	newId(): string;
	now(): Date;
};

// The only local writer: reads the group, plans, applies and queues in one transaction, so two quick taps
// plan against what the first one wrote. Storage failures throw and roll everything back.
export function createCommitter(deps: CommitterDeps): Commit {
	const { db, userId, isAnonymous } = deps;
	return async (intent) => {
		const now = deps.now();
		const ctx: PlanContext = {
			newId: deps.newId,
			now: now.toISOString(),
			today: localDate(now),
			isAnonymous,
		};
		const plan = await db.transaction("rw", writeTables(db), async () => {
			const state =
				intent.type === "createGroup" ? null : await readGroupState(db, intent.groupId, userId, isAnonymous);
			const plan = planChange(state, intent, ctx);
			if (!plan.ok) return plan;
			const tables = dexieTables(db);
			for (const mutation of plan.mutations) {
				await applyMutation(tables, mutation, userId);
				await db.outbox.add({ id: mutation.id, mutation });
			}
			return plan;
		});
		if (plan.ok && plan.mutations.length > 0) deps.requestSync();
		return plan;
	};
}

const CommitContext = createContext<Commit | null>(null);

export const CommitProvider = CommitContext.Provider;

export function useCommit(): Commit {
	const commit = useContext(CommitContext);
	if (!commit) throw new Error("useCommit must be used inside the signed-in layout");
	return commit;
}
