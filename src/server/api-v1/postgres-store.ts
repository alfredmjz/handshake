import type { SQL } from "bun";

import {
	ApiStoreError,
	type ApiStore,
	type GroupDetailRow,
	type GroupRowApi,
	type MeRow,
	type PaymentPageRow,
} from "./store";

// The production ApiStore: one SELECT api.v1_*(…) per method, as handshake_api (D5 does the work).
// A NULL from v1_group or v1_payments means the group isn't the owner's; the call still counted.

type Row<T> = { result: T | null };

function toStoreError(failure: unknown): unknown {
	const { errno, detail } = (failure ?? {}) as { errno?: unknown; detail?: unknown };
	if (errno === "HS401") return new ApiStoreError("HS401", "The token is unknown or revoked");
	if (errno === "HS429") {
		const seconds = Number(detail);
		return new ApiStoreError("HS429", "Too many requests with this token", Number.isInteger(seconds) ? seconds : null);
	}
	return failure;
}

async function one<T>(query: Promise<Row<T>[]>): Promise<T> {
	let rows: Row<T>[];
	try {
		rows = await query;
	} catch (failure) {
		throw toStoreError(failure);
	}
	const result = rows[0]?.result ?? null;
	if (result === null) throw new ApiStoreError("HS404", "Not found");
	return result;
}

export function createPostgresApiStore(sql: SQL): ApiStore {
	return {
		me: (tokenHash) => one<MeRow>(sql`SELECT api.v1_me(${tokenHash}) AS result`),
		groups: (tokenHash) => one<GroupRowApi[]>(sql`SELECT api.v1_groups(${tokenHash}) AS result`),
		group: (tokenHash, groupId) =>
			one<GroupDetailRow>(sql`SELECT api.v1_group(${tokenHash}, ${groupId}::uuid) AS result`),
		payments: (tokenHash, query) =>
			one<PaymentPageRow>(
				sql`SELECT api.v1_payments(${tokenHash}, ${query.groupId}::uuid, ${JSON.stringify(query.cursor)}::text::jsonb, ${query.limit}::int) AS result`
			),
	};
}
