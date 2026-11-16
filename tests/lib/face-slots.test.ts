import { describe, expect, test } from "bun:test";

import { assignSlots, LOOKS, SLOTS, slotOf, TINTS } from "@/lib/face-slots";

describe("assignSlots", () => {
	test("a lone member keeps the slot their key hashes to", () => {
		expect(assignSlots([{ id: "m1", userId: "u1" }]).get("m1")).toBe(slotOf("u1"));
		expect(assignSlots([{ id: "m2", userId: null }]).get("m2")).toBe(slotOf("m2"));
	});

	test("nobody shares a slot, up to the number of slots", () => {
		const members = Array.from({ length: SLOTS }, (_, i) => ({ id: `m${i}`, userId: i % 2 ? `u${i}` : null }));
		expect(new Set(assignSlots(members).values()).size).toBe(SLOTS);
	});

	test("the answer does not depend on the order given", () => {
		const members = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, userId: null }));
		const a = assignSlots(members);
		const b = assignSlots([...members].reverse());
		for (const m of members) expect(a.get(m.id)).toBe(b.get(m.id));
	});

	test("a clash moves the later key to the next free slot", () => {
		let other = 0;
		while (slotOf(`x${other}`) !== slotOf("x-first") || `x${other}` === "x-first") other++;
		const slots = assignSlots([
			{ id: "a", userId: "x-first" },
			{ id: "b", userId: `x${other}` },
		]);
		expect(slots.get("a")).not.toBe(slots.get("b"));
	});

	test("up to six people get six different disc colours", () => {
		const members = Array.from({ length: TINTS }, (_, i) => ({ id: `m${i}`, userId: `user-${i * 7}` }));
		const tints = [...assignSlots(members).values()].map((s) => Math.floor(s / LOOKS));
		expect(new Set(tints).size).toBe(TINTS);
	});

	test("someone who chose a face has it, and the others are dealt around it", () => {
		const home = slotOf("u1");
		const slots = assignSlots([
			{ id: "chooser", userId: "u2", chosen: home },
			{ id: "dealt", userId: "u1" },
		]);
		expect(slots.get("chooser")).toBe(home);
		expect(slots.get("dealt")).not.toBe(home);
		expect(Math.floor(slots.get("dealt")! / LOOKS)).not.toBe(Math.floor(home / LOOKS));
	});

	test("two people who chose the same face both keep it", () => {
		const slots = assignSlots([
			{ id: "a", userId: "u1", chosen: 7 },
			{ id: "b", userId: "u2", chosen: 7 },
		]);
		expect([slots.get("a"), slots.get("b")]).toEqual([7, 7]);
	});

	test("more members than slots still all get one", () => {
		const members = Array.from({ length: SLOTS + 3 }, (_, i) => ({ id: `m${i}`, userId: null }));
		expect(assignSlots(members).size).toBe(SLOTS + 3);
	});
});
