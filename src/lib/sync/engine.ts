import type { Cursors, Mutation, PullResult, PushResult, RejectedMutation } from "@/lib/sync/types";

export interface SyncStore {
	pendingMutations(): Promise<Mutation[]>;
	removeMutations(ids: string[]): Promise<void>;
	cursors(): Promise<Cursors>;
	applyPull(pull: PullResult): Promise<void>;
}

export interface SyncTransport {
	push(mutations: Mutation[]): Promise<PushResult>;
	pull(cursors: Cursors): Promise<PullResult>;
}

export type SyncOutcome = { pushed: number; rejected: RejectedMutation[] };

const PUSH_BATCH_SIZE = 50;

// Push first so the pull already contains this device's changes. Any network or server failure
// throws with the queue untouched, and the next sync sends it again.
export async function syncOnce(store: SyncStore, transport: SyncTransport): Promise<SyncOutcome> {
	const pending = await store.pendingMutations();
	const rejected: RejectedMutation[] = [];
	let pushed = 0;

	for (let start = 0; start < pending.length; start += PUSH_BATCH_SIZE) {
		const result = await transport.push(pending.slice(start, start + PUSH_BATCH_SIZE));
		await store.removeMutations([...result.applied, ...result.rejected.map((r) => r.id)]);
		pushed += result.applied.length;
		rejected.push(...result.rejected);
	}

	await store.applyPull(await transport.pull(await store.cursors()));
	return { pushed, rejected };
}
