import { createApiV1 } from "../../src/server/api-v1/index";
import { hashToken } from "../../src/server/api-v1/token";
import { createMemoryApiWorld } from "../support/memory-api-store";

// The docs' example, in the memory store with fixed ids and a fixed clock: Banff trip (Alex owns), a $10
// dinner Sam paid for Alex, Jo and Sam, Alex's 333 paid back and confirmed by Sam, and Jo's 333 still
// waiting for Sam. Kim has a group of her own.

export const NOW = "2026-11-04T18:20:00.000Z";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const IDS = {
	alex: id(1),
	sam: id(2),
	jo: id(3),
	kim: id(4),
	banff: id(5),
	alexMember: id(6),
	samMember: id(7),
	joMember: id(8),
	dinner: id(9),
	alexPaid: id(10),
	joPending: id(11),
	kims: id(12),
	kimMember: id(13),
};

// Real-looking tokens; the store only ever sees their hashes.
export const TOKENS = {
	sam: `hsk_${"S".repeat(43)}`,
	jo: `hsk_${"J".repeat(43)}`,
};

export async function dinnerWorld(options: { now?: () => Date } = {}) {
	const world = createMemoryApiWorld({ now: options.now ?? (() => new Date(NOW)) });
	const { seed, fixture } = world;
	for (const name of ["Alex", "Sam", "Jo", "Kim"]) await seed.user(name);
	await seed.group("Alex", "Banff trip");
	await seed.join("Sam", IDS.banff);
	await seed.join("Jo", IDS.banff);
	await seed.bill("Sam", IDS.banff, {
		amountCents: 1000,
		paidBy: IDS.samMember,
		splitAmong: [IDS.alexMember, IDS.joMember, IDS.samMember],
	});
	await seed.payment("Alex", IDS.banff, IDS.alexMember, IDS.samMember, 333, "Sam");
	await seed.payment("Jo", IDS.banff, IDS.joMember, IDS.samMember, 333);
	await seed.group("Kim", "Kim's");

	for (const [name, token] of [
		["Sam", TOKENS.sam],
		["Jo", TOKENS.jo],
	] as const) {
		fixture.tokens.set(await hashToken(token), {
			userId: name === "Sam" ? IDS.sam : IDS.jo,
			revoked: false,
			windowStart: null,
			windowCount: 0,
		});
	}
	return { ...world, handle: createApiV1({ store: world.store }) };
}

export function get(path: string, token: string | null = TOKENS.sam, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	if (token !== null) headers.set("Authorization", `Bearer ${token}`);
	return new Request(`https://handshake.example${path}`, { method: "GET", ...init, headers });
}
