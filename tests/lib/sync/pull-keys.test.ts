import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { toPullResult } from "@/lib/sync/wire";
import type { RawPull } from "@/lib/sync/wire";

import { PULL_KEYS_SQL_PATH, readPullScenario, renderPullKeysSql } from "../../../scripts/pull-keys-sql";
import { PULL_KEYS, PULL_KEYS_THE_DEVICE_IGNORES } from "../../fixtures/pull-keys";
import type { PullLevel } from "../../fixtures/pull-keys";

const LEVELS = Object.keys(PULL_KEYS) as PullLevel[];

// What a key holds when the reader needs more than a plain value.
const NESTED: Partial<Record<PullLevel, Record<string, () => unknown>>> = {
	pull: { group_ids: () => ["g1"], moved_away: () => [], changes: () => [row("changes")] },
	changes: {
		groups: () => [row("groups")],
		members: () => [row("members")],
		entries: () => [row("entries")],
		conflicts: () => [row("conflicts")],
		invites: () => [row("invites")],
		nudges: () => [row("nudges")],
		guest_codes: () => [row("guest_codes")],
	},
	entries: { shares: () => [row("shares")], items: () => null },
	shares: { owed_to: () => ({ m1: 1 }) },
	conflicts: { base: () => null, proposed: () => null },
};

let read: Record<PullLevel, Set<string>>;

// A row with exactly the fixture's keys for its level, noting every key the reader asks for.
function row(level: PullLevel): object {
	const target = Object.fromEntries(
		PULL_KEYS[level].map((key) => [key, NESTED[level]?.[key]?.() ?? `${level}.${key}`])
	);
	return new Proxy(target, {
		get(object, key, receiver) {
			if (typeof key === "string") read[level].add(key);
			return Reflect.get(object, key, receiver);
		},
	});
}

function readWholePull(): Record<PullLevel, Set<string>> {
	read = Object.fromEntries(LEVELS.map((level) => [level, new Set<string>()])) as Record<PullLevel, Set<string>>;
	toPullResult(row("pull") as RawPull);
	return read;
}

describe("the pull key table", () => {
	test("supabase/tests/pull_keys.test.sql is current (run `bun run gen:pull-keys`)", () => {
		const onDisk = readFileSync(PULL_KEYS_SQL_PATH, "utf8").replaceAll("\r\n", "\n");
		expect(onDisk).toBe(renderPullKeysSql(PULL_KEYS, readPullScenario()));
	});

	test("each level's keys are sorted and listed once", () => {
		for (const level of LEVELS) {
			const keys = PULL_KEYS[level];
			expect([...new Set(keys)].sort()).toEqual(keys);
		}
	});

	test.each(LEVELS)("wire.ts reads every %s key the server sends", (level) => {
		const ignored = PULL_KEYS_THE_DEVICE_IGNORES[level] ?? [];
		const unread = PULL_KEYS[level].filter((key) => !readWholePull()[level].has(key) && !ignored.includes(key));
		expect(unread).toEqual([]);
	});

	test.each(LEVELS)("wire.ts reads no %s key the server doesn't send", (level) => {
		const unsent = [...readWholePull()[level]].filter((key) => !PULL_KEYS[level].includes(key));
		expect(unsent).toEqual([]);
	});

	test("the keys marked as ignored are sent, and not read", () => {
		const keys = readWholePull();
		for (const [level, ignored] of Object.entries(PULL_KEYS_THE_DEVICE_IGNORES) as Array<[PullLevel, string[]]>) {
			for (const key of ignored) {
				expect(PULL_KEYS[level]).toContain(key);
				expect(keys[level].has(key)).toBe(false);
			}
		}
	});
});
