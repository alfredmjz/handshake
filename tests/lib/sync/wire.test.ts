import { describe, expect, test } from "bun:test";

import {
	toConflictRow,
	toEntryRow,
	toGroupRow,
	toInviteRow,
	toMemberRow,
	toPullResult,
	type RawConflict,
	type RawEntry,
	type RawGroup,
	type RawInvite,
	type RawMember,
} from "@/lib/sync/wire";

const T = "2026-11-02T09:30:00.123456+00:00";

// Each raw row has exactly the keys pull_changes() emits (supabase/migrations/010_categories_notes.sql).
const rawGroup: RawGroup = {
	id: "g1",
	name: "Japan 2027",
	note: "Tokyo and Kyoto, April",
	base_currency: "CAD",
	created_by: null,
	created_at: T,
	deleted_at: null,
	completed_at: T,
	completed_by_member_id: "m1",
	row_version: 2,
};

const rawMember: RawMember = {
	id: "m1",
	group_id: "g1",
	user_id: null,
	display_name: "Sam",
	role: "guest",
	joined_at: T,
	deleted_at: null,
	row_version: 1,
};

const rawBill: RawEntry = {
	id: "e1",
	group_id: "g1",
	kind: "expense",
	description: "Dinner",
	amount_cents: 1000,
	items: [{ id: "i1", description: "Food", amountCents: 1000, paidBy: "m1", splitAmong: ["m1", "m2"] }],
	entry_date: "2026-11-02",
	notes: "Ramen",
	category: "food",
	payment_status: null,
	payer_confirmed_at: null,
	receiver_confirmed_at: null,
	confirmed_at: null,
	closed_at: null,
	close_note: null,
	created_by_member_id: "m1",
	updated_by_member_id: "m2",
	created_at: T,
	updated_at: T,
	deleted_at: null,
	row_version: 3,
	shares: [
		{ member_id: "m1", paid_cents: 1000, owed_cents: 500, owed_to: { m1: 500 } },
		{ member_id: "m2", paid_cents: 0, owed_cents: 500, owed_to: { m1: 500 } },
	],
};

const rawPayment: RawEntry = {
	...rawBill,
	id: "p1",
	kind: "payment",
	description: "Payment",
	items: null,
	notes: null,
	category: null,
	payment_status: "declined",
	payer_confirmed_at: T,
	receiver_confirmed_at: null,
	confirmed_at: null,
	closed_at: T,
	close_note: "Not yet",
	shares: [
		{ member_id: "m1", paid_cents: 1000, owed_cents: 0, owed_to: {} },
		{ member_id: "m2", paid_cents: 0, owed_cents: 1000, owed_to: { m1: 1000 } },
	],
};

const rawConflict: RawConflict = {
	id: "c1",
	group_id: "g1",
	entry_id: "e1",
	base_version: 2,
	base: {
		description: "Dinner",
		amountCents: 900,
		entryDate: "2026-11-02",
		notes: null,
		category: "food",
		items: [{ id: "i1", amountCents: 900, paidBy: "m1", splitAmong: ["m1"] }],
		shares: [{ memberId: "m1", paidCents: 900, owedCents: 900, owedTo: { m1: 900 } }],
		deletedAt: null,
		rowVersion: 2,
		updatedByMemberId: "m1",
	},
	proposed: null,
	proposed_by_member_id: "m2",
	created_at: T,
	resolved_at: T,
	resolved_by_member_id: "m1",
	resolution: "kept_current",
	row_version: 4,
};

const rawInvite: RawInvite = {
	id: "inv1",
	group_id: "g1",
	claim_member_id: "m2",
	created_by: "u1",
	created_at: T,
	expires_at: T,
	revoked_at: null,
	row_version: 5,
};

describe("wire", () => {
	test("groups drop base_currency", () => {
		expect(toGroupRow(rawGroup)).toEqual({
			id: "g1",
			name: "Japan 2027",
			note: "Tokyo and Kyoto, April",
			createdBy: null,
			createdAt: T,
			deletedAt: null,
			completedAt: T,
			completedByMemberId: "m1",
			rowVersion: 2,
		});
	});

	test("members", () => {
		expect(toMemberRow(rawMember)).toEqual({
			id: "m1",
			groupId: "g1",
			userId: null,
			displayName: "Sam",
			role: "guest",
			joinedAt: T,
			deletedAt: null,
			rowVersion: 1,
		});
	});

	test("bills keep their items as written and map shares with owedTo", () => {
		expect(toEntryRow(rawBill)).toEqual({
			id: "e1",
			groupId: "g1",
			kind: "expense",
			description: "Dinner",
			amountCents: 1000,
			items: [{ id: "i1", description: "Food", amountCents: 1000, paidBy: "m1", splitAmong: ["m1", "m2"] }],
			entryDate: "2026-11-02",
			notes: "Ramen",
			category: "food",
			paymentStatus: null,
			payerConfirmedAt: null,
			receiverConfirmedAt: null,
			confirmedAt: null,
			closedAt: null,
			closeNote: null,
			createdByMemberId: "m1",
			updatedByMemberId: "m2",
			createdAt: T,
			updatedAt: T,
			deletedAt: null,
			rowVersion: 3,
			shares: [
				{ memberId: "m1", paidCents: 1000, owedCents: 500, owedTo: { m1: 500 } },
				{ memberId: "m2", paidCents: 0, owedCents: 500, owedTo: { m1: 500 } },
			],
		});
	});

	test("payments carry their handshake fields", () => {
		expect(toEntryRow(rawPayment)).toMatchObject({
			kind: "payment",
			items: null,
			paymentStatus: "declined",
			payerConfirmedAt: T,
			receiverConfirmedAt: null,
			confirmedAt: null,
			closedAt: T,
			closeNote: "Not yet",
			shares: [
				{ memberId: "m1", paidCents: 1000, owedCents: 0, owedTo: {} },
				{ memberId: "m2", paidCents: 0, owedCents: 1000, owedTo: { m1: 1000 } },
			],
		});
	});

	test("conflicts pass their camelCase snapshots through", () => {
		expect(toConflictRow(rawConflict)).toEqual({
			id: "c1",
			groupId: "g1",
			entryId: "e1",
			baseVersion: 2,
			base: rawConflict.base,
			proposed: null,
			proposedByMemberId: "m2",
			createdAt: T,
			resolvedAt: T,
			resolvedByMemberId: "m1",
			resolution: "kept_current",
			rowVersion: 4,
		});
	});

	test("snapshots written before categories read as having none", () => {
		const { category: _, ...oldBase } = rawConflict.base!;
		const old = { ...rawConflict, base: oldBase, proposed: oldBase } as unknown as RawConflict;
		const row = toConflictRow(old);
		expect(row.base).toEqual({ ...rawConflict.base!, category: null });
		expect(row.proposed).toEqual({ ...oldBase, category: null });
	});

	test("rows without note or category read as none", () => {
		const { note: _, ...group } = rawGroup;
		const { category: __, ...bill } = rawBill;
		expect(toGroupRow(group as RawGroup).note).toBeNull();
		expect(toEntryRow(bill as RawEntry).category).toBeNull();
	});

	test("invites", () => {
		expect(toInviteRow(rawInvite)).toEqual({
			id: "inv1",
			groupId: "g1",
			claimMemberId: "m2",
			createdBy: "u1",
			createdAt: T,
			expiresAt: T,
			revokedAt: null,
			rowVersion: 5,
		});
	});

	test("a whole pull reply", () => {
		expect(
			toPullResult({
				group_ids: ["g1", "g2"],
				changes: [
					{
						group_id: "g1",
						version: 5,
						groups: [rawGroup],
						members: [rawMember],
						entries: [rawBill, rawPayment],
						conflicts: [rawConflict],
						invites: [rawInvite],
					},
				],
			})
		).toEqual({
			groupIds: ["g1", "g2"],
			changes: [
				{
					groupId: "g1",
					version: 5,
					groups: [toGroupRow(rawGroup)],
					members: [toMemberRow(rawMember)],
					entries: [toEntryRow(rawBill), toEntryRow(rawPayment)],
					conflicts: [toConflictRow(rawConflict)],
					invites: [toInviteRow(rawInvite)],
				},
			],
		});
	});
});
