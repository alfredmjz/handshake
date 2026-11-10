import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { createApiV1 } from "../../src/server/api-v1/index";
import { ApiStoreError } from "../../src/server/api-v1/store";
import { dinnerWorld, get, IDS, NOW, TOKENS } from "./dinner";

// Every response the handler gives is checked against docs/api-v1.openapi.yaml (ADR-002), with every
// object closed so an undocumented field fails. Plus the golden JSON from the docs' example.

type Schema = Record<string, unknown>;
const doc = Bun.YAML.parse(await Bun.file(new URL("../../docs/api-v1.openapi.yaml", import.meta.url)).text()) as {
	paths: Record<string, Record<string, { responses: Record<string, Schema> }>>;
	components: { schemas: Record<string, Schema>; responses: Record<string, Schema>; headers: Record<string, Schema> };
};

function resolve(node: Schema): Schema {
	const ref = node.$ref as string | undefined;
	if (!ref) return node;
	const [, , section, name] = ref.split("/");
	return resolve((doc.components as Record<string, Record<string, Schema>>)[section][name]);
}

// Inlines $refs and closes every object. Inside an allOf, the branches stay open and the allOf itself is
// closed, because unevaluatedProperties only sees what its own subschema evaluated.
function close(node: Schema, inAllOf = false): Schema {
	const schema = { ...resolve(node) };
	for (const key of ["oneOf", "anyOf"] as const) {
		if (Array.isArray(schema[key])) schema[key] = (schema[key] as Schema[]).map((s) => close(s, inAllOf));
	}
	if (Array.isArray(schema.allOf)) {
		schema.allOf = (schema.allOf as Schema[]).map((s) => close(s, true));
		if (!inAllOf) schema.unevaluatedProperties = false;
	}
	if (schema.properties) {
		schema.properties = Object.fromEntries(
			Object.entries(schema.properties as Record<string, Schema>).map(([k, v]) => [k, close(v)])
		);
	}
	if (schema.items) schema.items = close(schema.items as Schema);
	if (schema.type === "object" && !inAllOf) schema.unevaluatedProperties = false;
	return schema;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// The route template in the contract for a request path.
function operationFor(path: string) {
	const relative = path.replace(/^\/api\/v1/, "").split("?")[0];
	const template = Object.keys(doc.paths).find((p) =>
		new RegExp(`^${p.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(relative)
	);
	return template ? doc.paths[template].get : null;
}

const checked = new Set<string>();

async function expectContract(path: string, response: Response) {
	const status = String(response.status);
	checked.add(status);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	if (status === "204") return;
	expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");

	// 404 for unknown paths and 405 aren't per operation; they use the shared Error body.
	const declared = operationFor(path)?.responses[status];
	const spec = declared
		? resolve(declared)
		: { content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
	const schema = (spec.content as Record<string, { schema: Schema }>)["application/json"].schema;
	const validate = ajv.compile(close(schema));
	const body = await response.json();
	if (!validate(body))
		throw new Error(`${path} ${status}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(body)}`);

	for (const [name, header] of Object.entries((spec.headers ?? {}) as Record<string, Schema>)) {
		const value = response.headers.get(name);
		expect(value).not.toBeNull();
		const headerSchema = resolve(header).schema as Schema;
		const typed = headerSchema.type === "integer" ? Number(value) : value;
		if (!ajv.validate(headerSchema, typed)) throw new Error(`${path} ${status}: header ${name} = ${value}`);
	}
}

const sortKeys = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(sortKeys)
		: value && typeof value === "object"
			? Object.fromEntries(
					Object.entries(value)
						.sort(([a], [b]) => (a < b ? -1 : 1))
						.map(([k, v]) => [k, sortKeys(v)])
				)
			: value;

describe("every response matches docs/api-v1.openapi.yaml", () => {
	test("200s on every route, and a second feed page", async () => {
		const { handle } = await dinnerWorld();
		for (const path of [
			"/api/v1/me",
			"/api/v1/groups",
			`/api/v1/groups/${IDS.banff}`,
			`/api/v1/groups/${IDS.banff}/payments`,
			"/api/v1/payments?limit=1",
		]) {
			const response = await handle(get(path));
			expect(response.status).toBe(200);
			await expectContract(path, response);
		}
		const first = await (await handle(get("/api/v1/payments"))).json();
		await expectContract("/api/v1/payments", await handle(get(`/api/v1/payments?cursor=${first.nextCursor}`)));
		await expectContract("/api/v1/groups", await handle(get("/api/v1/groups", TOKENS.jo)));
		await expectContract(`/api/v1/groups/${IDS.banff}`, await handle(get(`/api/v1/groups/${IDS.banff}`, TOKENS.jo)));
	});

	test("204, 400, 401, 404, 405, 429 and 500", async () => {
		const { handle } = await dinnerWorld();
		const cases: [string, Request][] = [
			["/api/v1/me", get("/api/v1/me", null, { method: "OPTIONS" })],
			["/api/v1/payments?limit=0", get("/api/v1/payments?limit=0")],
			[`/api/v1/groups/${IDS.banff}/payments?cursor=nope!`, get(`/api/v1/groups/${IDS.banff}/payments?cursor=nope!`)],
			["/api/v1/me", get("/api/v1/me", null)],
			["/api/v1/groups", get("/api/v1/groups", `hsk_${"U".repeat(43)}`)],
			[`/api/v1/groups/${IDS.kims}`, get(`/api/v1/groups/${IDS.kims}`)],
			[`/api/v1/groups/${IDS.kims}/payments`, get(`/api/v1/groups/${IDS.kims}/payments`)],
			["/api/v1/nope", get("/api/v1/nope")],
			["/api/v1/me", get("/api/v1/me", TOKENS.sam, { method: "POST" })],
		];
		for (const [path, request] of cases) await expectContract(path, await handle(request));

		const limited = createApiV1({
			store: {
				me: () => Promise.reject(new ApiStoreError("HS429", "x", 12)),
				groups: () => Promise.reject(new Error("down")),
				group: () => Promise.reject(new Error("down")),
				payments: () => Promise.reject(new Error("down")),
			},
		});
		await expectContract("/api/v1/me", await limited(get("/api/v1/me")));
		const quiet = console.error;
		console.error = () => {};
		try {
			await expectContract("/api/v1/groups", await limited(get("/api/v1/groups")));
		} finally {
			console.error = quiet;
		}
		expect([...checked].sort()).toEqual(["200", "204", "400", "401", "404", "405", "429", "500"]);
	});
});

test("the closed schemas reject undocumented fields, inside allOf too", () => {
	const validate = ajv.compile(close({ $ref: "#/components/schemas/GroupDetail" }));
	const good = {
		id: IDS.banff,
		name: "Banff trip",
		role: "member",
		memberId: IDS.samMember,
		balanceCents: 333,
		completedAt: null,
		updatedAt: NOW,
		debts: [{ memberId: IDS.joMember, name: "Jo", direction: "owes_you", amountCents: 333 }],
	};
	expect(validate(good)).toBe(true);
	expect(validate({ ...good, paidCents: 1000 })).toBe(false);
	expect(validate({ ...good, debts: [{ ...good.debts[0], owedTo: {} }] })).toBe(false);
	expect(validate({ ...good, debts: undefined })).toBe(false);
});

describe("golden JSON (docs/api-v1.md)", () => {
	test("GET /groups/{id} for Sam after the $10 dinner and Alex's confirmed 333", async () => {
		const { handle } = await dinnerWorld();
		const body = await (await handle(get(`/api/v1/groups/${IDS.banff}`))).text();
		expect(JSON.stringify(sortKeys(JSON.parse(body)))).toBe(
			JSON.stringify(
				sortKeys({
					id: IDS.banff,
					name: "Banff trip",
					role: "member",
					memberId: IDS.samMember,
					balanceCents: 333,
					completedAt: null,
					updatedAt: NOW,
					debts: [{ memberId: IDS.joMember, name: "Jo", direction: "owes_you", amountCents: 333 }],
				})
			)
		);
	});

	test("GET /payments for Sam: Alex's payment, received", async () => {
		const { handle, seed } = await dinnerWorld();
		const body = JSON.parse(await (await handle(get("/api/v1/payments"))).text());
		const head = await seed.headVersion(IDS.banff);
		expect(JSON.stringify(sortKeys(body))).toBe(
			JSON.stringify(
				sortKeys({
					payments: [
						{
							id: IDS.alexPaid,
							groupId: IDS.banff,
							groupName: "Banff trip",
							direction: "received",
							counterpartyMemberId: IDS.alexMember,
							counterpartyName: "Alex",
							amountCents: 333,
							entryDate: "2026-11-04",
							notes: null,
							confirmedAt: NOW,
						},
					],
					nextCursor: Buffer.from(JSON.stringify({ v: 1, scope: "all", groups: { [IDS.banff]: head } })).toString(
						"base64url"
					),
					hasMore: false,
					removedGroupIds: [],
				})
			)
		);
	});
});
