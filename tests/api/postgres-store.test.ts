import { SQL } from "bun";

import { createPostgresApiStore } from "../../src/server/api-v1/postgres-store";
import { hashToken } from "../../src/server/api-v1/token";
import { describeApiStore, type ApiSeeder, type ApiWorld } from "./store.contract";

// The store contract suite against the local Supabase, with `bun run test:api-db`. The store connects as
// handshake_api, exactly as the Vercel function does. The scenario is seeded the way the app writes:
// push_changes, join_group and create_api_token, called as each signed-in user through the admin
// connection (HANDSHAKE_TEST_ADMIN_DATABASE_URL, local postgres by default). Skipped without
// HANDSHAKE_API_DATABASE_URL.

const API_URL = process.env.HANDSHAKE_API_DATABASE_URL;
const ADMIN_URL =
	process.env.HANDSHAKE_TEST_ADMIN_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";

async function makeWorld(): Promise<ApiWorld> {
	const api = new SQL({ url: API_URL!, prepare: false, max: 2 });
	const admin = new SQL({ url: ADMIN_URL, prepare: false, max: 2 });
	const users = new Map<string, string>();
	const groups: string[] = [];
	const userId = (name: string) => users.get(name)!;

	// Runs `run` as the signed-in user, the way PostgREST would call it.
	async function as<T>(name: string, run: (tx: SQL) => Promise<T>): Promise<T> {
		const claims = JSON.stringify({ sub: userId(name), role: "authenticated", is_anonymous: false });
		return admin.begin(async (tx) => {
			await tx`SELECT set_config('request.jwt.claims', ${claims}, true)`;
			await tx`SET LOCAL ROLE authenticated`;
			return run(tx);
		}) as Promise<T>;
	}

	async function push(name: string, mutation: Record<string, unknown>) {
		const id = crypto.randomUUID();
		const batch = JSON.stringify([{ id, at: new Date().toISOString(), ...mutation }]);
		const [{ result }] = await as(name, (tx) => tx`SELECT public.push_changes(${batch}::text::jsonb) AS result`);
		if (!result.applied.includes(id))
			throw new Error(`push_changes rejected ${mutation.type}: ${JSON.stringify(result.rejected)}`);
	}

	async function memberId(name: string, groupId: string): Promise<string> {
		const [row] =
			await admin`SELECT id FROM public.group_members WHERE group_id = ${groupId} AND user_id = ${userId(name)} AND deleted_at IS NULL`;
		return row.id;
	}

	const today = new Date().toISOString().slice(0, 10);

	const seed: ApiSeeder = {
		async user(name) {
			const id = crypto.randomUUID();
			users.set(name, id);
			await admin`
				INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
				VALUES (${id}, ${`${name.toLowerCase()}-${id}@contract.test`}, '00000000-0000-0000-0000-000000000000',
					'authenticated', 'authenticated', FALSE, ${JSON.stringify({ display_name: name })}::text::jsonb)`;
			return id;
		},
		async group(owner, name) {
			const groupId = crypto.randomUUID();
			groups.push(groupId);
			await push(owner, { type: "group.create", groupId, memberId: crypto.randomUUID(), name, displayName: owner });
			return groupId;
		},
		async join(user, groupId) {
			const [ownerRow] = await admin`
				SELECT u.id FROM public.group_members gm JOIN auth.users u ON u.id = gm.user_id
				WHERE gm.group_id = ${groupId} AND gm.role = 'owner' AND gm.deleted_at IS NULL`;
			const owner = [...users].find(([, id]) => id === ownerRow.id)![0];
			const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
			await push(owner, {
				type: "invite.create",
				groupId,
				inviteId: crypto.randomUUID(),
				token,
				claimMemberId: null,
				expiresAt: null,
			});
			await as(user, (tx) => tx`SELECT public.join_group(${token}, NULL, ${user})`);
			return memberId(user, groupId);
		},
		async addPerson(by, groupId, name) {
			const id = crypto.randomUUID();
			await push(by, { type: "member.add", groupId, memberId: id, displayName: name });
			return id;
		},
		memberId,
		async bill(by, groupId, item) {
			const entryId = crypto.randomUUID();
			const { computeShares } = await import("../../src/lib/ledger");
			const items = [{ id: "item", ...item }];
			await push(by, {
				type: "entry.create",
				groupId,
				entryId,
				description: "Bill",
				amountCents: item.amountCents,
				entryDate: today,
				notes: null,
				items,
				shares: computeShares(items),
			});
			return entryId;
		},
		async payment(by, groupId, from, to, amountCents, confirmBy) {
			const entryId = crypto.randomUUID();
			await push(by, {
				type: "payment.record",
				groupId,
				entryId,
				fromMemberId: from,
				toMemberId: to,
				amountCents,
				entryDate: today,
				notes: null,
			});
			if (confirmBy) await push(confirmBy, { type: "payment.confirm", groupId, entryId });
			return entryId;
		},
		async leave(user, groupId) {
			await push(user, { type: "member.remove", groupId, memberId: await memberId(user, groupId) });
		},
		async deleteGroup(owner, groupId) {
			await push(owner, { type: "group.delete", groupId });
		},
		async token(user) {
			const [{ created }] = await as(user, (tx) => tx`SELECT public.create_api_token('Contract test') AS created`);
			return {
				hash: await hashToken(created.token),
				revoke: async () => {
					await as(user, (tx) => tx`SELECT public.revoke_api_token(${created.id}::uuid)`);
				},
			};
		},
		async headVersion(groupId) {
			const [row] = await admin`SELECT head_version FROM public.groups WHERE id = ${groupId}`;
			return Number(row.head_version);
		},
	};

	return {
		store: createPostgresApiStore(api),
		seed,
		async cleanup() {
			for (const groupId of groups) await admin`DELETE FROM public.groups WHERE id = ${groupId}`;
			for (const id of users.values()) await admin`DELETE FROM auth.users WHERE id = ${id}`;
			await api.close();
			await admin.close();
		},
	};
}

describeApiStore("Postgres", makeWorld, { skip: !API_URL });
