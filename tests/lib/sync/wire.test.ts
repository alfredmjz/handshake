import { expect, test } from "bun:test";

import { toPullResult } from "@/lib/sync/wire";

test("maps the server's pull reply to local rows", () => {
	expect(
		toPullResult({
			group_ids: ["g1"],
			changes: [
				{
					group_id: "g1",
					version: 2,
					groups: [
						{
							id: "g1",
							name: "Japan 2027",
							base_currency: "JPY",
							created_by: "u1",
							created_at: "2026-11-02T09:30:00+00:00",
							deleted_at: null,
							row_version: 2,
						},
					],
					members: [
						{
							id: "m1",
							group_id: "g1",
							user_id: null,
							display_name: "Sam",
							role: "member",
							deleted_at: null,
							row_version: 1,
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
				version: 2,
				groups: [
					{
						id: "g1",
						name: "Japan 2027",
						baseCurrency: "JPY",
						createdBy: "u1",
						createdAt: "2026-11-02T09:30:00+00:00",
						deletedAt: null,
						rowVersion: 2,
					},
				],
				members: [
					{ id: "m1", groupId: "g1", userId: null, displayName: "Sam", role: "member", deletedAt: null, rowVersion: 1 },
				],
			},
		],
	});
});
