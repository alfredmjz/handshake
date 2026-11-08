import { expect, test } from "bun:test";

import { toPullResult } from "@/lib/sync/wire";

// Rows as pull_changes() sends them, with exactly the keys pgTAP pins (docs/architecture.md §11.2).
test("maps the server's pull reply to local rows", () => {
	const items = [{ id: "i1", amountCents: 1000, paidBy: "m1", splitAmong: ["m1", "m2"] }];
	const snapshot = {
		description: "Dinner",
		amountCents: 1000,
		entryDate: "2026-11-02",
		notes: null,
		items,
		shares: [],
		deletedAt: null,
		rowVersion: 2,
		updatedByMemberId: "m1",
	};

	expect(
		toPullResult({
			group_ids: ["g1"],
			changes: [
				{
					group_id: "g1",
					version: 4,
					groups: [
						{
							id: "g1",
							name: "Japan 2027",
							base_currency: "CAD",
							created_by: null,
							created_at: "2026-11-02T09:30:00+00:00",
							deleted_at: null,
							completed_at: "2026-11-03T10:00:00+00:00",
							completed_by_member_id: "m1",
							row_version: 3,
						},
					],
					members: [
						{
							id: "m2",
							group_id: "g1",
							user_id: null,
							display_name: "Sam",
							role: "guest",
							joined_at: null,
							deleted_at: null,
							row_version: 1,
						},
					],
					entries: [
						{
							id: "e1",
							group_id: "g1",
							kind: "payment",
							description: "Payment",
							amount_cents: 500,
							items: null,
							entry_date: "2026-11-02",
							notes: "Cash",
							payment_status: "pending",
							payer_confirmed_at: "2026-11-02T09:31:00+00:00",
							receiver_confirmed_at: null,
							confirmed_at: null,
							closed_at: null,
							close_note: null,
							created_by_member_id: "m1",
							updated_by_member_id: "m1",
							created_at: "2026-11-02T09:31:00+00:00",
							updated_at: "2026-11-02T09:31:00+00:00",
							deleted_at: null,
							row_version: 4,
							shares: [
								{ member_id: "m1", paid_cents: 500, owed_cents: 0, owed_to: {} },
								{ member_id: "m2", paid_cents: 0, owed_cents: 500, owed_to: { m1: 500 } },
							],
						},
					],
					conflicts: [
						{
							id: "c1",
							group_id: "g1",
							entry_id: "e0",
							base_version: 2,
							base: snapshot,
							proposed: null,
							proposed_by_member_id: "m2",
							created_at: "2026-11-02T09:32:00+00:00",
							resolved_at: null,
							resolved_by_member_id: null,
							resolution: null,
							row_version: 4,
						},
					],
					invites: [
						{
							id: "i1",
							group_id: "g1",
							claim_member_id: "m2",
							created_by: "u1",
							created_at: "2026-11-02T09:33:00+00:00",
							expires_at: "2026-11-16T09:33:00+00:00",
							revoked_at: null,
							row_version: 4,
						},
					],
				},
			],
		})
	).toEqual({
		groupIds: ["g1"],
		changes: [
			{
				groupId: "g1",
				version: 4,
				groups: [
					{
						id: "g1",
						name: "Japan 2027",
						createdBy: null,
						createdAt: "2026-11-02T09:30:00+00:00",
						deletedAt: null,
						completedAt: "2026-11-03T10:00:00+00:00",
						completedByMemberId: "m1",
						rowVersion: 3,
					},
				],
				members: [
					{
						id: "m2",
						groupId: "g1",
						userId: null,
						displayName: "Sam",
						role: "guest",
						joinedAt: null,
						deletedAt: null,
						rowVersion: 1,
					},
				],
				entries: [
					{
						id: "e1",
						groupId: "g1",
						kind: "payment",
						description: "Payment",
						amountCents: 500,
						items: null,
						entryDate: "2026-11-02",
						notes: "Cash",
						paymentStatus: "pending",
						payerConfirmedAt: "2026-11-02T09:31:00+00:00",
						receiverConfirmedAt: null,
						confirmedAt: null,
						closedAt: null,
						closeNote: null,
						createdByMemberId: "m1",
						updatedByMemberId: "m1",
						createdAt: "2026-11-02T09:31:00+00:00",
						updatedAt: "2026-11-02T09:31:00+00:00",
						deletedAt: null,
						rowVersion: 4,
						shares: [
							{ memberId: "m1", paidCents: 500, owedCents: 0, owedTo: {} },
							{ memberId: "m2", paidCents: 0, owedCents: 500, owedTo: { m1: 500 } },
						],
					},
				],
				conflicts: [
					{
						id: "c1",
						groupId: "g1",
						entryId: "e0",
						baseVersion: 2,
						base: snapshot,
						proposed: null,
						proposedByMemberId: "m2",
						createdAt: "2026-11-02T09:32:00+00:00",
						resolvedAt: null,
						resolvedByMemberId: null,
						resolution: null,
						rowVersion: 4,
					},
				],
				invites: [
					{
						id: "i1",
						groupId: "g1",
						claimMemberId: "m2",
						createdBy: "u1",
						createdAt: "2026-11-02T09:33:00+00:00",
						expiresAt: "2026-11-16T09:33:00+00:00",
						revokedAt: null,
						rowVersion: 4,
					},
				],
			},
		],
	});
});
