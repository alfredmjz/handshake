// What a change gets in one group: accepted, or the first refusal's code. planChange (src/lib/changes.ts)
// and push_changes() (SQL) must both give it. Written by hand from the rules; nothing here is computed by
// the code under test. tests/lib/refusal-cases.test.ts runs planChange on each case;
// `bun run gen:refusal-cases` renders the table into supabase/tests/refusal_cases.test.sql, which pushes each
// mutation (tests/lib/refusal-cases-sql.test.ts fails while that file is stale).
//
// - Only codes are pinned; each side words its own reasons (ADR-007).
// - Every case starts from WORLD (below; its SQL twin is supabase/tests/refusal-world.psql), as `actor`, in an
//   open, completed or deleted group. Each runs on its own: the SQL side raises and catches after each, undoing it.
// - `intent` is what a screen asks planChange for, `mutation` what a device would push for it (the server
//   adds nothing; the runner adds the mutation id). `intent: null` marks a change no screen plans (invites are
//   made online, src/lib/groups.ts): only push_changes runs it.
// - `mismatch` marks a case where the two sides disagree today. Neither side is changed here: each runner
//   checks its own side still gives what is recorded, so a fix on either side fails the row and asks for it
//   to become an ordinary case.

import type { ExpenseDraft, GroupState, Intent } from "@/lib/changes";
import type { BillFields, EntryRow, Item, MemberRow, Mutation, Share } from "@/lib/sync/types";

export type Actor = "alex" | "sam" | "kim" | "out";
export type GroupSetup = "open" | "completed" | "deleted";
export type Outcome = "accepted" | "HS403" | "HS404" | "HS409" | "HS422";

// A mutation as pushed, without its id; loose so a case can carry a malformed field.
export type CaseMutation = { type: Mutation["type"]; [field: string]: unknown };

export type Mismatch = { planChange: Outcome; pushChanges: Outcome; why: string };

export type RefusalCase = {
	name: string;
	actor: Actor;
	group: GroupSetup;
	intent: Intent | null;
	mutation: CaseMutation;
} & ({ expect: Outcome; mismatch?: undefined } | { expect?: undefined; mismatch: Mismatch });

// What one side must give for a case.
export function expectedOutcome(refusalCase: RefusalCase, side: "planChange" | "pushChanges"): Outcome {
	return refusalCase.mismatch ? refusalCase.mismatch[side] : refusalCase.expect;
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export const GROUP = "10000000-0000-0000-0000-000000000001";
export const NEW_GROUP = "10000000-0000-0000-0000-000000000002";

// Alex owns the group, Sam is a member, Kim a guest (anonymous login), Out is in no group, Lee left.
export const USERS: Record<Actor | "lee", string> = {
	alex: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
	sam: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
	kim: "cccccccc-cccc-cccc-cccc-cccccccccccc",
	out: "dddddddd-dddd-dddd-dddd-dddddddddddd",
	lee: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
};

export const MEMBERS = {
	alex: "20000000-0000-0000-0000-0000000000a1",
	sam: "20000000-0000-0000-0000-0000000000b1",
	kim: "20000000-0000-0000-0000-0000000000c1",
	// A name-only person.
	pat: "20000000-0000-0000-0000-0000000000f1",
	// Joined, then left.
	lee: "20000000-0000-0000-0000-0000000000e1",
	// Not in the group: what a new person gets.
	jo: "20000000-0000-0000-0000-0000000000d1",
};

export const ENTRIES = {
	// 900 Alex paid, split by Alex, Sam and Pat; it has the open conflict.
	alexBill: "30000000-0000-0000-0000-000000000001",
	// 600 Sam paid, split by Sam and Kim.
	samBill: "30000000-0000-0000-0000-000000000002",
	// Sam paid Alex back 100, waiting for Alex.
	samPayment: "30000000-0000-0000-0000-000000000003",
	missing: "30000000-0000-0000-0000-000000000008",
	new: "30000000-0000-0000-0000-000000000009",
};

export const CONFLICT = "50000000-0000-0000-0000-000000000001";
export const SAM_INVITE = "40000000-0000-0000-0000-000000000001";
const NEW_INVITE = "40000000-0000-0000-0000-000000000002";
const NEW_NUDGE = "60000000-0000-0000-0000-000000000009";

// When planChange runs: the nudge Sam sent Kim is from earlier the same day.
export const NOW = "2026-11-13T12:00:00.000Z";
const EARLIER = "2026-11-13T09:00:00.000Z";

const member = (id: string, displayName: string, role: MemberRow["role"], userId: string | null): MemberRow => ({
	id,
	groupId: GROUP,
	userId,
	displayName,
	role,
	joinedAt: userId ? EARLIER : null,
	deletedAt: null,
	rowVersion: 1,
});

// owedTo is everyone's even part, owed to the payer (who owes their own part to themselves).
function evenShares(payer: string, among: string[], amountCents: number): Share[] {
	const part = amountCents / among.length;
	const shares = among.map((id) => ({
		memberId: id,
		paidCents: id === payer ? amountCents : 0,
		owedCents: part,
		owedTo: { [payer]: part },
	}));
	if (!among.includes(payer)) shares.push({ memberId: payer, paidCents: amountCents, owedCents: 0, owedTo: {} });
	return shares;
}

function billRow(id: string, description: string, payer: string, among: string[], amountCents: number): EntryRow {
	return {
		id,
		groupId: GROUP,
		kind: "expense",
		description,
		amountCents,
		items: [{ id: "i1", amountCents, paidBy: payer, splitAmong: among }],
		entryDate: "2026-11-02",
		notes: null,
		category: null,
		paymentStatus: null,
		payerConfirmedAt: null,
		receiverConfirmedAt: null,
		confirmedAt: null,
		closedAt: null,
		closeNote: null,
		createdByMemberId: payer,
		updatedByMemberId: payer,
		createdAt: EARLIER,
		updatedAt: EARLIER,
		deletedAt: null,
		rowVersion: 2,
		shares: evenShares(payer, among, amountCents),
	};
}

// The group as each person's device holds it; null for Out, who isn't in it.
export function worldState(actor: Actor, setup: GroupSetup): GroupState | null {
	if (actor === "out") return null;
	const completed = setup === "completed";
	const members: MemberRow[] = [
		member(MEMBERS.alex, "Alex", "owner", USERS.alex),
		member(MEMBERS.sam, "Sam", "member", USERS.sam),
		// Completing a group turns its guests into name-only people (migration 008).
		completed ? member(MEMBERS.kim, "Kim", "member", null) : member(MEMBERS.kim, "Kim", "guest", USERS.kim),
		member(MEMBERS.pat, "Pat", "member", null),
		{ ...member(MEMBERS.lee, "Lee", "member", USERS.lee), deletedAt: EARLIER },
	];
	const alexBill = {
		...billRow(ENTRIES.alexBill, "Ramen dinner", MEMBERS.alex, [MEMBERS.alex, MEMBERS.sam, MEMBERS.pat], 900),
		rowVersion: 3,
	};
	const samBill = billRow(ENTRIES.samBill, "Groceries", MEMBERS.sam, [MEMBERS.sam, MEMBERS.kim], 600);
	const samPayment: EntryRow = {
		...billRow(ENTRIES.samPayment, "Payment", MEMBERS.sam, [MEMBERS.alex], 100),
		kind: "payment",
		items: null,
		entryDate: "2026-11-04",
		paymentStatus: "pending",
		payerConfirmedAt: EARLIER,
		// The payer "paid" it, the receiver "owes" it to them (architecture 9.3).
		shares: [
			{ memberId: MEMBERS.sam, paidCents: 100, owedCents: 0, owedTo: {} },
			{ memberId: MEMBERS.alex, paidCents: 0, owedCents: 100, owedTo: { [MEMBERS.sam]: 100 } },
		],
	};
	const me = members.find((m) => m.id === MEMBERS[actor])!;
	return {
		group: {
			id: GROUP,
			name: "Banff",
			note: null,
			coverColor: null,
			coverSticker: null,
			createdBy: USERS.alex,
			createdAt: EARLIER,
			deletedAt: setup === "deleted" ? NOW : null,
			completedAt: completed ? NOW : null,
			completedByMemberId: completed ? MEMBERS.alex : null,
			joinCode: "HX7K2P",
			rowVersion: 5,
		},
		members,
		entries: [alexBill, samBill, samPayment],
		conflicts: [
			{
				id: CONFLICT,
				groupId: GROUP,
				entryId: ENTRIES.alexBill,
				baseVersion: 2,
				base: null,
				proposed: null,
				proposedByMemberId: MEMBERS.sam,
				createdAt: EARLIER,
				resolvedAt: null,
				resolvedByMemberId: null,
				resolution: null,
				rowVersion: 4,
			},
		],
		nudges: [
			{
				id: "60000000-0000-0000-0000-000000000001",
				groupId: GROUP,
				fromMemberId: MEMBERS.sam,
				toMemberId: MEMBERS.kim,
				amountCents: 300,
				createdAt: EARLIER,
				rowVersion: 5,
			},
		],
		me: { memberId: me.id, role: me.role, isAnonymous: actor === "kim" },
	};
}

// ---------------------------------------------------------------------------
// Builders: one intent and its mutation
// ---------------------------------------------------------------------------

type Case = RefusalCase extends infer R
	? R extends RefusalCase
		? Omit<R, "group"> & { group?: GroupSetup }
		: never
	: never;
const c = (rc: Case): RefusalCase => ({ group: "open", ...rc }) as RefusalCase;

const groupChange = (
	intent: Intent extends infer I ? (I extends { groupId: string } ? Omit<I, "groupId"> : never) : never,
	mutation: CaseMutation
) => ({ intent: { ...intent, groupId: GROUP } as Intent, mutation: { groupId: GROUP, ...mutation } });

type BillOptions = Partial<Pick<BillFields, "description" | "entryDate" | "notes">> & { category?: string | null };

// A bill split evenly (the amount divides evenly), as a draft and as entry.create's fields.
function bill(payer: string, among: string[], amountCents: number, options: BillOptions = {}) {
	const fields = { description: "Taxi", entryDate: "2026-11-05", notes: null, category: null, ...options };
	const items: Item[] = [{ id: "i1", amountCents, paidBy: payer, splitAmong: among }];
	return {
		draft: { ...fields, items } as ExpenseDraft,
		fields: { ...fields, amountCents, items, shares: evenShares(payer, among, amountCents) },
	};
}

const addBill = (b: ReturnType<typeof bill>) =>
	groupChange({ type: "addExpense", draft: b.draft }, { type: "entry.create", entryId: ENTRIES.new, ...b.fields });

const editBill = (entryId: string, b: ReturnType<typeof bill>) =>
	groupChange(
		{ type: "editExpense", entryId, draft: b.draft },
		{ type: "entry.update", entryId, baseVersion: 3, ...b.fields }
	);

const pay = (from: string, to: string, amountCents: number, entryDate = "2026-11-06", notes: string | null = null) =>
	groupChange(
		{ type: "recordPayment", from, to, amountCents, entryDate, notes },
		{ type: "payment.record", entryId: ENTRIES.new, fromMemberId: from, toMemberId: to, amountCents, entryDate, notes }
	);

const recolor = (color: string | null) =>
	groupChange({ type: "recolorGroup", color }, { type: "group.recolor", color });
const stick = (sticker: string | null) =>
	groupChange({ type: "stickGroup", sticker }, { type: "group.sticker", sticker });
const rename = (name: string) => groupChange({ type: "renameGroup", name }, { type: "group.rename", name });
const describe = (note: string | null) =>
	groupChange({ type: "describeGroup", note }, { type: "group.describe", note });
const addPerson = (displayName: string) =>
	groupChange({ type: "addPerson", displayName }, { type: "member.add", memberId: MEMBERS.jo, displayName });
const renamePerson = (memberId: string, displayName: string) =>
	groupChange({ type: "renamePerson", memberId, displayName }, { type: "member.rename", memberId, displayName });
const removePerson = (memberId: string) =>
	groupChange({ type: "removePerson", memberId }, { type: "member.remove", memberId });
const deleteEntry = (entryId: string) =>
	groupChange({ type: "deleteEntry", entryId }, { type: "entry.delete", entryId, baseVersion: 3 });
const confirm = (entryId: string) =>
	groupChange({ type: "confirmPayment", entryId }, { type: "payment.confirm", entryId });
const decline = (entryId: string, note: string | null) =>
	groupChange({ type: "declinePayment", entryId, note }, { type: "payment.decline", entryId, note });
const undo = (entryId: string) => groupChange({ type: "undoPayment", entryId }, { type: "payment.undo", entryId });
const nudge = (memberId: string, amountCents: number) =>
	groupChange(
		{ type: "nudge", memberId },
		{ type: "nudge.send", nudgeId: NEW_NUDGE, toMemberId: memberId, amountCents }
	);
const resolveDeleted = (conflictId: string) =>
	groupChange(
		{ type: "resolveConflict", conflictId, resolution: "took_proposed", final: "deleted" },
		{
			type: "conflict.resolve",
			conflictId,
			entryId: ENTRIES.alexBill,
			resolution: "took_proposed",
			entry: { deleted: true },
		}
	);
const groupOnly = (
	intentType: "deleteGroup" | "completeGroup" | "reopenGroup" | "resetGroupCode",
	type: Mutation["type"]
) => groupChange({ type: intentType }, { type });
const online = (mutation: CaseMutation) => ({ intent: null, mutation: { groupId: GROUP, ...mutation } });

const createGroup = (name: string, displayName: string, note: string | null = null) => ({
	intent: { type: "createGroup", name, displayName, note } as Intent,
	mutation: { type: "group.create" as const, groupId: NEW_GROUP, memberId: MEMBERS.jo, name, displayName, note },
});

const AMONG_ALEX_SAM_PAT = [MEMBERS.alex, MEMBERS.sam, MEMBERS.pat];
const AMONG_SAM_KIM = [MEMBERS.sam, MEMBERS.kim];
const text = (length: number) => "x".repeat(length);

// ---------------------------------------------------------------------------
// The cases, by mutation kind, refusals in the server's order of checks
// ---------------------------------------------------------------------------

export const REFUSAL_CASES: RefusalCase[] = [
	// group.create: the account, then the note, then the name.
	c({ name: "Alex creates a group", actor: "alex", ...createGroup("Jasper", "Alex"), expect: "accepted" }),
	c({ name: "a guest can't create a group", actor: "kim", ...createGroup("Jasper", "Kim"), expect: "HS403" }),
	c({
		name: "a group note of 121 characters is too long",
		actor: "alex",
		...createGroup("Jasper", "Alex", text(121)),
		expect: "HS422",
	}),
	c({
		name: "a group name of 80 characters is fine",
		actor: "alex",
		...createGroup(text(80), "Alex"),
		expect: "accepted",
	}),
	c({
		name: "a group name of 81 characters is too long",
		actor: "alex",
		...createGroup(text(81), "Alex"),
		expect: "HS422",
	}),
	c({
		name: "a blank group name is refused",
		actor: "alex",
		...createGroup("   ", "Alex"),
		expect: "HS422",
	}),
	c({
		name: "an owner's name of 61 characters is too long",
		actor: "alex",
		...createGroup("Jasper", text(61)),
		expect: "HS422",
	}),
	c({
		name: "a blank owner's name is refused",
		actor: "alex",
		...createGroup("Jasper", "  "),
		expect: "HS422",
	}),

	// group.rename
	c({ name: "the owner renames the group", actor: "alex", ...rename("Lake Louise"), expect: "accepted" }),
	c({ name: "a member can't rename the group", actor: "sam", ...rename("Lake Louise"), expect: "HS403" }),
	c({ name: "someone outside the group can't rename it", actor: "out", ...rename("Lake Louise"), expect: "HS403" }),
	c({
		name: "a completed group can't be renamed",
		actor: "alex",
		group: "completed",
		...rename("Lake Louise"),
		expect: "HS403",
	}),
	c({
		name: "a deleted group can't be renamed",
		actor: "alex",
		group: "deleted",
		...rename("Lake Louise"),
		expect: "HS403",
	}),
	c({
		name: "a group name of 81 characters is too long (rename)",
		actor: "alex",
		...rename(text(81)),
		expect: "HS422",
	}),
	c({ name: "a blank group name is refused (rename)", actor: "alex", ...rename(" "), expect: "HS422" }),

	// group.describe: as renaming, then the note.
	c({ name: "the owner sets the note", actor: "alex", ...describe("April"), expect: "accepted" }),
	c({ name: "a note of 120 characters is fine", actor: "alex", ...describe(text(120)), expect: "accepted" }),
	c({ name: "a note of 121 characters is too long", actor: "alex", ...describe(text(121)), expect: "HS422" }),
	c({ name: "a member can't set the note", actor: "sam", ...describe("April"), expect: "HS403" }),

	// group.recolor: anyone in the group; a key on the board (h0-h17, s0-s4).
	c({ name: "a member paints the cover h17s4", actor: "sam", ...recolor("h17s4"), expect: "accepted" }),
	c({ name: "a guest paints the cover h0s0", actor: "kim", ...recolor("h0s0"), expect: "accepted" }),
	c({ name: "null goes back to the default colour", actor: "sam", ...recolor(null), expect: "accepted" }),
	c({ name: "h18s0 is off the board", actor: "sam", ...recolor("h18s0"), expect: "HS422" }),
	c({ name: "h3s5 is off the board", actor: "sam", ...recolor("h3s5"), expect: "HS422" }),
	c({ name: "a padded h03s1 is refused", actor: "sam", ...recolor("h03s1"), expect: "HS422" }),
	c({ name: "a hex colour is refused", actor: "sam", ...recolor("#ff0000"), expect: "HS422" }),
	c({
		name: "a completed group can't be recoloured",
		actor: "sam",
		group: "completed",
		...recolor("h1s1"),
		expect: "HS403",
	}),
	c({
		name: "someone outside can't recolour, even with a good colour",
		actor: "out",
		...recolor("h1s1"),
		expect: "HS403",
	}),
	c({
		name: "someone outside with a colour off the board",
		actor: "out",
		...recolor("h99s9"),
		expect: "HS403",
	}),

	// group.sticker: anyone in the group; a hand, one emoji, or a small png/jpeg/webp picture.
	c({ name: "a member sticks a hand on the cover", actor: "sam", ...stick("hand:travel"), expect: "accepted" }),
	c({ name: "the new-group hand is a sticker", actor: "sam", ...stick("hand:new"), expect: "accepted" }),
	c({ name: "an emoji is a sticker", actor: "kim", ...stick("emoji:🇯🇵"), expect: "accepted" }),
	c({
		name: "a small webp picture is a sticker",
		actor: "sam",
		...stick("data:image/webp;base64,UklGRg=="),
		expect: "accepted",
	}),
	c({ name: "null goes back to the default sticker", actor: "sam", ...stick(null), expect: "accepted" }),
	c({ name: "a hand that isn't drawn is refused", actor: "sam", ...stick("hand:boat"), expect: "HS422" }),
	c({ name: "letters are not an emoji", actor: "sam", ...stick("emoji:abc"), expect: "HS422" }),
	c({ name: "a gif is refused", actor: "sam", ...stick("data:image/gif;base64,R0lGOD=="), expect: "HS422" }),
	c({
		name: "a completed group can't take a sticker",
		actor: "sam",
		group: "completed",
		...stick("hand:fun"),
		expect: "HS403",
	}),

	// group.delete, group.complete, group.reopen, group.recode: the owner's.
	c({
		name: "the owner deletes the group",
		actor: "alex",
		...groupOnly("deleteGroup", "group.delete"),
		expect: "accepted",
	}),
	c({
		name: "a member can't delete the group",
		actor: "sam",
		...groupOnly("deleteGroup", "group.delete"),
		expect: "HS403",
	}),
	c({
		name: "a completed group can still be deleted",
		actor: "alex",
		group: "completed",
		...groupOnly("deleteGroup", "group.delete"),
		expect: "accepted",
	}),
	c({
		name: "the owner completes the group",
		actor: "alex",
		...groupOnly("completeGroup", "group.complete"),
		expect: "accepted",
	}),
	c({
		name: "a member can't complete the group",
		actor: "sam",
		...groupOnly("completeGroup", "group.complete"),
		expect: "HS403",
	}),
	c({
		name: "a completed group can't be completed again",
		actor: "alex",
		group: "completed",
		...groupOnly("completeGroup", "group.complete"),
		expect: "HS403",
	}),
	c({
		name: "the owner reopens a completed group",
		actor: "alex",
		group: "completed",
		...groupOnly("reopenGroup", "group.reopen"),
		expect: "accepted",
	}),
	c({
		name: "reopening an open group does nothing",
		actor: "alex",
		...groupOnly("reopenGroup", "group.reopen"),
		expect: "accepted",
	}),
	c({
		name: "a member can't reopen the group",
		actor: "sam",
		group: "completed",
		...groupOnly("reopenGroup", "group.reopen"),
		expect: "HS403",
	}),
	c({
		name: "the owner resets the group code",
		actor: "alex",
		...groupOnly("resetGroupCode", "group.recode"),
		expect: "accepted",
	}),
	c({
		name: "a member can't reset the group code",
		actor: "sam",
		...groupOnly("resetGroupCode", "group.recode"),
		expect: "HS403",
	}),

	// member.add: the matrix, the name, then unique names.
	c({ name: "the owner adds Jo", actor: "alex", ...addPerson("Jo"), expect: "accepted" }),
	c({ name: "a member adds Jo", actor: "sam", ...addPerson("Jo"), expect: "accepted" }),
	c({ name: "a guest can't add people", actor: "kim", ...addPerson("Jo"), expect: "HS403" }),
	c({
		name: "nobody is added to a completed group",
		actor: "alex",
		group: "completed",
		...addPerson("Jo"),
		expect: "HS403",
	}),
	c({ name: "a name of 60 characters is fine", actor: "alex", ...addPerson(text(60)), expect: "accepted" }),
	c({
		name: "a name of 61 characters is too long",
		actor: "alex",
		...addPerson(text(61)),
		expect: "HS422",
	}),
	c({ name: "a blank name is refused", actor: "alex", ...addPerson("  "), expect: "HS422" }),
	c({ name: '"pat" is already in the group', actor: "alex", ...addPerson(" pat "), expect: "HS409" }),
	c({ name: "Lee left, so the name is free again", actor: "alex", ...addPerson("Lee"), expect: "accepted" }),

	// member.rename: self or others, the person, the name, then unique names.
	c({ name: "Sam renames himself", actor: "sam", ...renamePerson(MEMBERS.sam, "Samuel"), expect: "accepted" }),
	c({ name: "a guest renames herself", actor: "kim", ...renamePerson(MEMBERS.kim, "Kimberly"), expect: "accepted" }),
	c({
		name: "a member can't rename someone else",
		actor: "sam",
		...renamePerson(MEMBERS.pat, "Patrick"),
		expect: "HS403",
	}),
	c({ name: "the owner renames Pat", actor: "alex", ...renamePerson(MEMBERS.pat, "Patrick"), expect: "accepted" }),
	c({ name: "renaming someone not in the group", actor: "alex", ...renamePerson(MEMBERS.jo, "Jo"), expect: "HS422" }),
	c({
		name: "a renamed name of 61 characters is too long",
		actor: "alex",
		...renamePerson(MEMBERS.pat, text(61)),
		expect: "HS422",
	}),
	c({ name: "Pat can't take Sam's name", actor: "alex", ...renamePerson(MEMBERS.pat, "SAM"), expect: "HS409" }),
	c({
		name: "a change of case only is still your own name",
		actor: "sam",
		...renamePerson(MEMBERS.sam, "SAM"),
		expect: "accepted",
	}),

	// member.remove: self (leaving) or others, then the person.
	c({ name: "the owner removes Pat", actor: "alex", ...removePerson(MEMBERS.pat), expect: "accepted" }),
	c({ name: "a member can't remove Pat", actor: "sam", ...removePerson(MEMBERS.pat), expect: "HS403" }),
	c({ name: "Sam leaves", actor: "sam", ...removePerson(MEMBERS.sam), expect: "accepted" }),
	c({ name: "a guest leaves", actor: "kim", ...removePerson(MEMBERS.kim), expect: "accepted" }),
	c({
		name: "leaving a completed group is allowed",
		actor: "sam",
		group: "completed",
		...removePerson(MEMBERS.sam),
		expect: "accepted",
	}),
	c({ name: "removing someone not in the group", actor: "alex", ...removePerson(MEMBERS.jo), expect: "HS422" }),
	c({
		name: "removing someone who already left does nothing",
		actor: "alex",
		...removePerson(MEMBERS.lee),
		expect: "accepted",
	}),
	c({ name: "the owner leaves", actor: "alex", ...removePerson(MEMBERS.alex), expect: "accepted" }),

	// entry.create: the matrix, then the bill checks in validate_entry's order, then the category.
	c({
		name: "a member adds a bill",
		actor: "sam",
		...addBill(bill(MEMBERS.sam, AMONG_ALEX_SAM_PAT, 900)),
		expect: "accepted",
	}),
	c({
		name: "a guest adds a bill",
		actor: "kim",
		...addBill(bill(MEMBERS.kim, AMONG_SAM_KIM, 400)),
		expect: "accepted",
	}),
	c({
		name: "someone outside can't add a bill",
		actor: "out",
		...addBill(bill(MEMBERS.sam, AMONG_SAM_KIM, 400)),
		expect: "HS403",
	}),
	c({
		name: "no bills in a completed group",
		actor: "alex",
		group: "completed",
		...addBill(bill(MEMBERS.alex, AMONG_ALEX_SAM_PAT, 900)),
		expect: "HS403",
	}),
	c({
		name: "a blank description is refused",
		actor: "sam",
		...addBill(bill(MEMBERS.sam, AMONG_SAM_KIM, 400, { description: "  " })),
		expect: "HS422",
	}),
	c({
		name: "a description of 120 characters is fine",
		actor: "sam",
		...addBill(bill(MEMBERS.sam, AMONG_SAM_KIM, 400, { description: text(120) })),
		expect: "accepted",
	}),
	c({
		name: "a description of 121 characters is too long",
		actor: "sam",
		...addBill(bill(MEMBERS.sam, AMONG_SAM_KIM, 400, { description: text(121) })),
		expect: "HS422",
	}),
	c({
		name: "a date that isn't YYYY-MM-DD",
		actor: "sam",
		...addBill(bill(MEMBERS.sam, AMONG_SAM_KIM, 400, { entryDate: "2026-11-5" })),
		expect: "HS422",
	}),
	c({
		name: "30 February isn't a day",
		actor: "sam",
		...addBill(bill(MEMBERS.sam, AMONG_SAM_KIM, 400, { entryDate: "2026-02-30" })),
		expect: "HS422",
	}),
	c({
		name: "notes of 1000 characters are fine",
		actor: "sam",
		...addBill(bill(MEMBERS.sam, AMONG_SAM_KIM, 400, { notes: text(1000) })),
		expect: "accepted",
	}),
	c({
		name: "notes of 1001 characters are too long",
		actor: "sam",
		...addBill(bill(MEMBERS.sam, AMONG_SAM_KIM, 400, { notes: text(1001) })),
		expect: "HS422",
	}),
	c({
		name: "a split with someone not in the group",
		actor: "sam",
		...addBill(bill(MEMBERS.sam, [MEMBERS.sam, MEMBERS.jo], 400)),
		expect: "HS422",
	}),
	c({
		name: "a bill can split with someone who left",
		actor: "sam",
		...addBill(bill(MEMBERS.sam, [MEMBERS.sam, MEMBERS.lee], 400)),
		expect: "accepted",
	}),
	...(["food", "drinks", "stay", "travel", "groceries", "fun"] as const).map((category) =>
		c({
			name: `${category} is a category`,
			actor: "sam",
			...addBill(bill(MEMBERS.sam, AMONG_SAM_KIM, 400, { category })),
			expect: "accepted",
		})
	),
	c({
		name: "pets is not a category",
		actor: "sam",
		...addBill(bill(MEMBERS.sam, AMONG_SAM_KIM, 400, { category: "pets" })),
		expect: "HS422",
	}),
	c({
		name: "categories are lower case",
		actor: "sam",
		...addBill(bill(MEMBERS.sam, AMONG_SAM_KIM, 400, { category: "Food" })),
		expect: "HS422",
	}),

	// entry.update: the matrix, the entry, then the bill checks.
	c({
		name: "a member edits Alex's bill",
		actor: "sam",
		...editBill(ENTRIES.alexBill, bill(MEMBERS.alex, AMONG_ALEX_SAM_PAT, 1200)),
		expect: "accepted",
	}),
	c({
		name: "a guest can't edit a bill",
		actor: "kim",
		...editBill(ENTRIES.samBill, bill(MEMBERS.sam, AMONG_SAM_KIM, 800)),
		expect: "HS403",
	}),
	c({
		name: "a payment can't be edited",
		actor: "alex",
		...editBill(ENTRIES.samPayment, bill(MEMBERS.sam, [MEMBERS.alex], 100)),
		expect: "HS422",
	}),
	c({
		name: "editing a bill nobody has",
		actor: "sam",
		...editBill(ENTRIES.missing, bill(MEMBERS.sam, AMONG_SAM_KIM, 400)),
		expect: "accepted",
	}),
	c({
		name: "an edit still has to be a good bill",
		actor: "sam",
		...editBill(ENTRIES.alexBill, bill(MEMBERS.alex, AMONG_ALEX_SAM_PAT, 900, { description: "" })),
		expect: "HS422",
	}),
	c({
		name: "no edits in a completed group",
		actor: "alex",
		group: "completed",
		...editBill(ENTRIES.alexBill, bill(MEMBERS.alex, AMONG_ALEX_SAM_PAT, 900)),
		expect: "HS403",
	}),

	// entry.delete: own or others' (who added it), then the entry.
	c({ name: "Alex deletes his own bill", actor: "alex", ...deleteEntry(ENTRIES.alexBill), expect: "accepted" }),
	c({ name: "the owner deletes Sam's bill", actor: "alex", ...deleteEntry(ENTRIES.samBill), expect: "accepted" }),
	c({ name: "a member deletes Alex's bill", actor: "sam", ...deleteEntry(ENTRIES.alexBill), expect: "accepted" }),
	c({
		name: "a guest can't delete someone else's bill",
		actor: "kim",
		...deleteEntry(ENTRIES.samBill),
		expect: "HS403",
	}),
	c({ name: "a payment can't be deleted", actor: "sam", ...deleteEntry(ENTRIES.samPayment), expect: "HS422" }),
	c({ name: "deleting a bill nobody has", actor: "sam", ...deleteEntry(ENTRIES.missing), expect: "accepted" }),
	c({
		name: "no deletes in a completed group",
		actor: "alex",
		group: "completed",
		...deleteEntry(ENTRIES.alexBill),
		expect: "HS403",
	}),

	// conflict.resolve: the matrix, then the conflict.
	c({
		name: "the owner resolves the conflict by deleting the bill",
		actor: "alex",
		...resolveDeleted(CONFLICT),
		expect: "accepted",
	}),
	c({ name: "a member resolves the conflict", actor: "sam", ...resolveDeleted(CONFLICT), expect: "accepted" }),
	c({ name: "a guest can't resolve a conflict", actor: "kim", ...resolveDeleted(CONFLICT), expect: "HS403" }),
	c({
		name: "a conflict that isn't there",
		actor: "alex",
		...resolveDeleted("50000000-0000-0000-0000-000000000009"),
		expect: "HS404",
	}),

	// invite.create and invite.revoke: made online, so only the server runs them.
	c({
		name: "a member makes an invite",
		actor: "sam",
		...online({
			type: "invite.create",
			inviteId: NEW_INVITE,
			token: "refusalcasesinvitetoken00000000000000000002",
			claimMemberId: null,
			expiresAt: null,
		}),
		expect: "accepted",
	}),
	c({
		name: "a guest can't make an invite",
		actor: "kim",
		...online({
			type: "invite.create",
			inviteId: NEW_INVITE,
			token: "refusalcasesinvitetoken00000000000000000002",
			claimMemberId: null,
			expiresAt: null,
		}),
		expect: "HS403",
	}),
	c({
		name: "Sam revokes his own invite",
		actor: "sam",
		...online({ type: "invite.revoke", inviteId: SAM_INVITE }),
		expect: "accepted",
	}),
	c({
		name: "the owner revokes Sam's invite",
		actor: "alex",
		...online({ type: "invite.revoke", inviteId: SAM_INVITE }),
		expect: "accepted",
	}),
	c({
		name: "a guest can't revoke an invite",
		actor: "kim",
		...online({ type: "invite.revoke", inviteId: SAM_INVITE }),
		expect: "HS403",
	}),

	// payment.record: own or others', the sides, who may record, amount, date, notes, then one pending at a time.
	c({
		name: "Alex records paying Pat (counts at once)",
		actor: "alex",
		...pay(MEMBERS.alex, MEMBERS.pat, 100),
		expect: "accepted",
	}),
	c({
		name: "Kim records paying Sam (waits for Sam)",
		actor: "kim",
		...pay(MEMBERS.kim, MEMBERS.sam, 300),
		expect: "accepted",
	}),
	c({
		name: "a member records Pat paying Lee: neither can answer",
		actor: "sam",
		...pay(MEMBERS.pat, MEMBERS.lee, 100),
		expect: "accepted",
	}),
	c({
		name: "a guest can't record a payment between others",
		actor: "kim",
		...pay(MEMBERS.pat, MEMBERS.lee, 100),
		expect: "HS403",
	}),
	c({
		name: "not between others when one of them can answer",
		actor: "sam",
		...pay(MEMBERS.pat, MEMBERS.kim, 100),
		expect: "HS422",
	}),
	c({ name: "both sides must be in the group", actor: "alex", ...pay(MEMBERS.alex, MEMBERS.jo, 100), expect: "HS422" }),
	c({
		name: "a payment is between two people",
		actor: "alex",
		...pay(MEMBERS.alex, MEMBERS.alex, 100),
		expect: "HS422",
	}),
	c({ name: "a payment of 0 is refused", actor: "alex", ...pay(MEMBERS.alex, MEMBERS.pat, 0), expect: "HS422" }),
	c({
		name: "a payment of 10^12 + 1 cents is refused",
		actor: "alex",
		...pay(MEMBERS.alex, MEMBERS.pat, 1_000_000_000_001),
		expect: "HS422",
	}),
	c({
		name: "a payment on 30 February is refused",
		actor: "alex",
		...pay(MEMBERS.alex, MEMBERS.pat, 100, "2026-02-30"),
		expect: "HS422",
	}),
	c({
		name: "a payment with notes of 1001 characters is refused",
		actor: "alex",
		...pay(MEMBERS.alex, MEMBERS.pat, 100, "2026-11-06", text(1001)),
		expect: "HS422",
	}),
	c({
		name: "one payment between two people waits at a time",
		actor: "alex",
		...pay(MEMBERS.alex, MEMBERS.sam, 100),
		expect: "HS409",
	}),
	c({
		name: "no payments in a completed group",
		actor: "alex",
		group: "completed",
		...pay(MEMBERS.alex, MEMBERS.pat, 100),
		expect: "HS403",
	}),
	c({
		name: "a payment has no category",
		actor: "alex",
		intent: null,
		mutation: { ...pay(MEMBERS.alex, MEMBERS.pat, 100).mutation, category: "food" },
		expect: "HS422",
	}),

	// payment.confirm and payment.decline: the side that hasn't agreed answers.
	c({ name: "Alex confirms Sam's payment", actor: "alex", ...confirm(ENTRIES.samPayment), expect: "accepted" }),
	c({ name: "Sam can't confirm his own payment", actor: "sam", ...confirm(ENTRIES.samPayment), expect: "HS403" }),
	c({ name: "a bill isn't a payment to confirm", actor: "alex", ...confirm(ENTRIES.alexBill), expect: "HS422" }),
	c({
		name: "a payment the server never kept: confirming does nothing",
		actor: "alex",
		...confirm(ENTRIES.missing),
		expect: "accepted",
	}),
	c({
		name: "a payment can be answered in a completed group",
		actor: "alex",
		group: "completed",
		...confirm(ENTRIES.samPayment),
		expect: "accepted",
	}),
	c({
		name: "Alex declines it with a note",
		actor: "alex",
		...decline(ENTRIES.samPayment, "Not yet"),
		expect: "accepted",
	}),
	c({
		name: "a decline note of 200 characters is fine",
		actor: "alex",
		...decline(ENTRIES.samPayment, text(200)),
		expect: "accepted",
	}),
	c({
		name: "a decline note of 201 characters is too long",
		actor: "alex",
		...decline(ENTRIES.samPayment, text(201)),
		expect: "HS422",
	}),
	c({ name: "Sam can't decline his own payment", actor: "sam", ...decline(ENTRIES.samPayment, null), expect: "HS403" }),

	// payment.undo: only whoever recorded it, while it waits.
	c({ name: "Sam undoes his payment", actor: "sam", ...undo(ENTRIES.samPayment), expect: "accepted" }),
	c({ name: "Alex can't undo Sam's payment", actor: "alex", ...undo(ENTRIES.samPayment), expect: "HS403" }),
	c({ name: "a bill isn't a payment to undo", actor: "alex", ...undo(ENTRIES.alexBill), expect: "HS422" }),
	c({
		name: "no undoing in a completed group",
		actor: "sam",
		group: "completed",
		...undo(ENTRIES.samPayment),
		expect: "HS403",
	}),
	c({
		name: "a payment the server never kept: undoing does nothing",
		actor: "sam",
		...undo(ENTRIES.missing),
		expect: "accepted",
	}),

	// nudge.send: the person, then whether they owe you, then once a day. Sam owes Alex 300 (the pending 100
	// doesn't count yet); Kim owes Sam 300 and Sam nudged her today.
	c({ name: "Alex nudges Sam for 300", actor: "alex", ...nudge(MEMBERS.sam, 300), expect: "accepted" }),
	c({
		name: "a guest can nudge too, but Sam owes Kim nothing",
		actor: "kim",
		...nudge(MEMBERS.sam, 300),
		expect: "HS422",
	}),
	c({ name: "nudging someone not in the group", actor: "alex", ...nudge(MEMBERS.jo, 300), expect: "HS422" }),
	c({ name: "nudging yourself", actor: "alex", ...nudge(MEMBERS.alex, 300), expect: "HS422" }),
	c({ name: "nudging someone who left", actor: "alex", ...nudge(MEMBERS.lee, 300), expect: "HS422" }),
	c({ name: "nudging a name-only person", actor: "alex", ...nudge(MEMBERS.pat, 300), expect: "HS422" }),
	c({ name: "nudging someone who owes you nothing", actor: "alex", ...nudge(MEMBERS.kim, 300), expect: "HS422" }),
	c({ name: "one nudge a day", actor: "sam", ...nudge(MEMBERS.kim, 300), expect: "HS409" }),
	c({
		name: "no nudges in a completed group",
		actor: "alex",
		group: "completed",
		...nudge(MEMBERS.sam, 300),
		expect: "HS403",
	}),
];
