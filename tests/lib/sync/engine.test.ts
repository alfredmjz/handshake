import { describe, expect, test } from "bun:test";

import { syncOnce, type SyncStore, type SyncTransport } from "@/lib/sync/engine";
import type { Cursors, Mutation, PullResult, PushResult } from "@/lib/sync/types";

const rename = (id: string): Mutation => ({
	id,
	at: "2026-11-02T09:30:00.000Z",
	type: "group.rename",
	groupId: "g1",
	name: id,
});

function fakeStore(pending: Mutation[], cursors: Cursors = {}) {
	const calls: string[] = [];
	const queue = [...pending];
	const pulls: PullResult[] = [];
	const store: SyncStore = {
		pendingMutations: async () => [...queue],
		removeMutations: async (ids) => {
			calls.push(`remove ${ids.join(",")}`);
			const removed = new Set(ids);
			queue.splice(0, queue.length, ...queue.filter((m) => !removed.has(m.id)));
		},
		cursors: async () => cursors,
		applyPull: async (pull) => {
			calls.push("applyPull");
			pulls.push(pull);
		},
	};
	return { store, calls, queue, pulls };
}

function fakeTransport(pushResult: (batch: Mutation[]) => PushResult | Error, pull: PullResult | Error) {
	const calls: string[] = [];
	const transport: SyncTransport = {
		push: async (batch) => {
			calls.push(`push ${batch.length}`);
			const result = pushResult(batch);
			if (result instanceof Error) throw result;
			return result;
		},
		pull: async (cursors) => {
			calls.push(`pull ${JSON.stringify(cursors)}`);
			if (pull instanceof Error) throw pull;
			return pull;
		},
	};
	return { transport, calls };
}

const EMPTY_PULL: PullResult = { groupIds: [], changes: [] };
const applyAll = (batch: Mutation[]): PushResult => ({ applied: batch.map((m) => m.id), rejected: [] });

describe("syncOnce", () => {
	test("pushes the queue before pulling, then empties it", async () => {
		const { store, calls, queue } = fakeStore([rename("a"), rename("b")], { g1: 3 });
		const { transport, calls: sent } = fakeTransport(applyAll, EMPTY_PULL);

		expect(await syncOnce(store, transport)).toEqual({ pushed: 2, rejected: [] });
		expect(sent).toEqual(["push 2", 'pull {"g1":3}']);
		expect(calls).toEqual(["remove a,b", "applyPull"]);
		expect(queue).toEqual([]);
	});

	test("only pulls when nothing is waiting", async () => {
		const { store } = fakeStore([]);
		const { transport, calls: sent } = fakeTransport(applyAll, EMPTY_PULL);

		await syncOnce(store, transport);
		expect(sent).toEqual(["pull {}"]);
	});

	test("rejected changes leave the queue and are reported", async () => {
		const { store, queue } = fakeStore([rename("good"), rename("bad")]);
		const { transport } = fakeTransport(
			() => ({
				applied: ["good"],
				rejected: [{ id: "bad", code: "HS403", reason: "You are not a member of this group" }],
			}),
			EMPTY_PULL
		);

		expect(await syncOnce(store, transport)).toEqual({
			pushed: 1,
			rejected: [{ id: "bad", code: "HS403", reason: "You are not a member of this group" }],
		});
		expect(queue).toEqual([]);
	});

	test("a failed push keeps the queue and skips the pull", async () => {
		const { store, calls, queue } = fakeStore([rename("a")]);
		const { transport, calls: sent } = fakeTransport(() => new Error("Failed to fetch"), EMPTY_PULL);

		await expect(syncOnce(store, transport)).rejects.toThrow("Failed to fetch");
		expect(sent).toEqual(["push 1"]);
		expect(calls).toEqual([]);
		expect(queue.map((m) => m.id)).toEqual(["a"]);
	});

	test("sends a long queue in batches of 50", async () => {
		const pending = Array.from({ length: 120 }, (_, i) => rename(`m${i}`));
		const { store, queue } = fakeStore(pending);
		const { transport, calls: sent } = fakeTransport(applyAll, EMPTY_PULL);

		await syncOnce(store, transport);
		expect(sent.filter((call) => call.startsWith("push"))).toEqual(["push 50", "push 50", "push 20"]);
		expect(queue).toEqual([]);
	});
});
