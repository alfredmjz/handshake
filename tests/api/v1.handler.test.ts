import { describe, expect, spyOn, test } from "bun:test";

import { createApiV1 } from "../../src/server/api-v1/index";
import { ApiStoreError, type ApiStore } from "../../src/server/api-v1/store";
import { dinnerWorld, get, IDS, NOW, TOKENS } from "./dinner";

// A store that fails the test if the handler asks it anything.
const untouchable: ApiStore = {
	me: () => Promise.reject(new Error("store touched")),
	groups: () => Promise.reject(new Error("store touched")),
	group: () => Promise.reject(new Error("store touched")),
	payments: () => Promise.reject(new Error("store touched")),
};
const strict = createApiV1({ store: untouchable });

const errorCode = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;

describe("before the store is asked", () => {
	test("OPTIONS answers the preflight", async () => {
		const response = await strict(get("/api/v1/groups", null, { method: "OPTIONS" }));
		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Authorization");
		expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
		expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
		expect(response.headers.get("Content-Type")).toBeNull();
	});

	test("anything but GET or OPTIONS is 405", async () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
			const response = await strict(get("/api/v1/me", TOKENS.sam, { method }));
			expect(response.status).toBe(405);
			expect(response.headers.get("Allow")).toBe("GET, OPTIONS");
			if (method !== "HEAD") expect(await errorCode(response)).toBe("method_not_allowed");
		}
	});

	test("unknown paths are 404, token or not", async () => {
		for (const path of [
			"/api/v1",
			"/api/v1/",
			"/api/v1/nope",
			"/api/v1/me/",
			"/api/v1//me",
			"/api/v1/entries",
			"/api/v1/groups/not-a-uuid",
			`/api/v1/groups/${IDS.banff}/entries`,
			`/api/v1/groups/${IDS.banff}/payments/x`,
			"/api/v2/me",
		]) {
			const response = await strict(get(path, null));
			expect(response.status).toBe(404);
			expect(await errorCode(response)).toBe("not_found");
		}
	});

	test("a missing or malformed token is 401 with WWW-Authenticate", async () => {
		for (const header of [
			null,
			"",
			"hsk_x",
			"Bearer",
			`Bearer ${TOKENS.sam}x`,
			`Bearer ${TOKENS.sam.slice(0, -1)}`,
			`bearer ${TOKENS.sam}`,
			`Basic ${TOKENS.sam}`,
			`Bearer hsk_${"a".repeat(42)}+`,
		]) {
			const request = get("/api/v1/me", null);
			if (header !== null) request.headers.set("Authorization", header);
			const response = await strict(request);
			expect(response.status).toBe(401);
			expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
			expect(await errorCode(response)).toBe("invalid_token");
		}
	});

	test("a bad limit or cursor is 400", async () => {
		const groupCursor = (await (await (await dinnerWorld()).handle(get(`/api/v1/groups/${IDS.banff}/payments`))).json())
			.nextCursor;
		for (const query of [
			"limit=0",
			"limit=501",
			"limit=abc",
			"limit=1.5",
			"limit=-1",
			"limit=",
			"cursor=",
			"cursor=!!",
			"cursor=e30",
			`cursor=${groupCursor}`,
			`cursor=${btoa(JSON.stringify({ v: 1, scope: "all", groups: { "not-a-uuid": 1 } })).replace(/=+$/, "")}`,
			`cursor=${btoa(JSON.stringify({ v: 1, scope: "all", groups: { [IDS.banff]: -1 } })).replace(/=+$/, "")}`,
			`cursor=${btoa(JSON.stringify({ v: 2, scope: "all", groups: {} })).replace(/=+$/, "")}`,
		]) {
			const response = await strict(get(`/api/v1/payments?${query}`));
			expect(response.status).toBe(400);
			expect(await errorCode(response)).toBe("bad_request");
		}
	});
});

describe("store errors", () => {
	const failing = (failure: unknown) =>
		createApiV1({ store: { ...untouchable, me: () => Promise.reject(failure) } })(get("/api/v1/me"));

	test("HS401 is 401, HS404 is 404, HS429 is 429 with Retry-After", async () => {
		const unauthorized = await failing(new ApiStoreError("HS401", "x"));
		expect([unauthorized.status, unauthorized.headers.get("WWW-Authenticate")]).toEqual([401, "Bearer"]);
		expect((await failing(new ApiStoreError("HS404", "x"))).status).toBe(404);
		const limited = await failing(new ApiStoreError("HS429", "x", 17));
		expect([limited.status, limited.headers.get("Retry-After"), await errorCode(limited)]).toEqual([
			429,
			"17",
			"rate_limited",
		]);
		expect((await failing(new ApiStoreError("HS429", "x"))).headers.get("Retry-After")).toBe("60");
	});

	test("anything else is a 500, logged without the token or its hash", async () => {
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await failing(new Error("connection refused"));
			expect(response.status).toBe(500);
			expect(await errorCode(response)).toBe("server_error");
			const output = JSON.stringify(logged.mock.calls);
			expect(output).toContain("connection refused");
			expect(output).not.toContain(TOKENS.sam);
			expect(output).not.toContain("hsk_");
		} finally {
			logged.mockRestore();
		}
	});

	test("Postgres timestamps come out as ISO 8601 UTC with milliseconds", async () => {
		const handle = createApiV1({
			store: {
				...untouchable,
				groups: async () => [
					{
						id: IDS.banff,
						name: "Banff trip",
						role: "member",
						memberId: IDS.samMember,
						paidCents: 1000,
						owedCents: 667,
						completedAt: "2026-11-03T18:20:00.123456+00:00",
						updatedAt: "2026-11-03T12:20:00.5-06:00",
					},
				],
			},
		});
		const body = await (await handle(get("/api/v1/groups"))).json();
		expect(body.groups[0]).toMatchObject({
			balanceCents: 333,
			completedAt: "2026-11-03T18:20:00.123Z",
			updatedAt: "2026-11-03T18:20:00.500Z",
		});
	});
});

describe("answers", () => {
	test("every response is JSON, never cached, and open to any origin", async () => {
		const { handle } = await dinnerWorld();
		for (const path of ["/api/v1/me", "/api/v1/nope", "/api/v1/groups"]) {
			const response = await handle(get(path));
			expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		}
	});

	test("GET /me", async () => {
		const { handle } = await dinnerWorld();
		expect(await (await handle(get("/api/v1/me"))).json()).toEqual({ userId: IDS.sam, displayName: "Sam" });
	});

	test("GET /groups: Sam is owed 333 net; Jo owes 333 (the pending payment doesn't count)", async () => {
		const { handle } = await dinnerWorld();
		expect((await (await handle(get("/api/v1/groups"))).json()).groups).toEqual([
			{
				id: IDS.banff,
				name: "Banff trip",
				role: "member",
				memberId: IDS.samMember,
				balanceCents: 333,
				completedAt: null,
				updatedAt: NOW,
			},
		]);
		expect((await (await handle(get("/api/v1/groups", TOKENS.jo))).json()).groups[0].balanceCents).toBe(-333);
	});

	test("GET /groups/{id}: the person's own debts, each way", async () => {
		const { handle } = await dinnerWorld();
		const sam = await (await handle(get(`/api/v1/groups/${IDS.banff}`))).json();
		expect(sam.balanceCents).toBe(333);
		expect(sam.debts).toEqual([{ memberId: IDS.joMember, name: "Jo", direction: "owes_you", amountCents: 333 }]);
		const jo = await (await handle(get(`/api/v1/groups/${IDS.banff.toUpperCase()}`, TOKENS.jo))).json();
		expect(jo.debts).toEqual([{ memberId: IDS.samMember, name: "Sam", direction: "you_owe", amountCents: 333 }]);
	});

	test("GET /groups/{id} for a group the person isn't in is 404", async () => {
		const { handle } = await dinnerWorld();
		expect((await handle(get(`/api/v1/groups/${IDS.kims}`))).status).toBe(404);
	});

	test("GET /payments: Alex's payment as received for Sam, sent for nobody else, and never a pending one", async () => {
		const { handle } = await dinnerWorld();
		const sam = await (await handle(get("/api/v1/payments"))).json();
		expect(sam.payments.map((p: { id: string; direction: string }) => [p.id, p.direction])).toEqual([
			[IDS.alexPaid, "received"],
		]);
		expect(sam.hasMore).toBe(false);
		expect(sam.removedGroupIds).toEqual([]);

		const jo = await (await handle(get("/api/v1/payments", TOKENS.jo))).json();
		expect(jo.payments).toEqual([]);
	});

	test("the feed's cursor round-trips, and only works where it was issued", async () => {
		const { handle, seed } = await dinnerWorld();
		const first = await (await handle(get("/api/v1/payments"))).json();
		const again = await (await handle(get(`/api/v1/payments?cursor=${first.nextCursor}`))).json();
		expect(again.payments).toEqual([]);

		await seed.payment("Sam", IDS.banff, IDS.samMember, IDS.alexMember, 50, "Alex");
		const next = await (await handle(get(`/api/v1/payments?cursor=${again.nextCursor}&limit=500`))).json();
		expect(next.payments.map((p: { direction: string; amountCents: number }) => [p.direction, p.amountCents])).toEqual([
			["sent", 50],
		]);

		const scoped = await (await handle(get(`/api/v1/groups/${IDS.banff}/payments`))).json();
		expect(scoped.payments).toHaveLength(2);
		expect((await handle(get(`/api/v1/payments?cursor=${scoped.nextCursor}`))).status).toBe(400);
		expect((await handle(get(`/api/v1/groups/${IDS.banff}/payments?cursor=${first.nextCursor}`))).status).toBe(400);
		expect((await handle(get(`/api/v1/groups/${IDS.kims}/payments`))).status).toBe(404);
	});

	test("the 61st request in a minute is 429 with Retry-After", async () => {
		let now = Date.parse(NOW);
		const { handle } = await dinnerWorld({ now: () => new Date(now) });
		for (let i = 0; i < 60; i++) expect((await handle(get("/api/v1/me"))).status).toBe(200);
		now += 20_000;
		const limited = await handle(get("/api/v1/me"));
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBe("40");
		now += 40_000;
		expect((await handle(get("/api/v1/me"))).status).toBe(200);
	});

	test("a revoked or unknown token is 401", async () => {
		const { handle } = await dinnerWorld();
		expect((await handle(get("/api/v1/me", `hsk_${"U".repeat(43)}`))).status).toBe(401);
	});
});
