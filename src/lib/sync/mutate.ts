import { db } from "@/lib/local-db";
import { requestSync } from "@/lib/sync/controller";
import { dexieTables } from "@/lib/sync/dexie-store";
import { applyMutation } from "@/lib/sync/local";
import type { Mutation } from "@/lib/sync/types";

// The only way the app changes data: apply it on this device now and queue it for the server.
export async function mutate(mutation: Mutation, userId: string) {
	await db.transaction("rw", [db.groups, db.members, db.cursors, db.outbox], async () => {
		await applyMutation(dexieTables(db), mutation, userId);
		await db.outbox.add({ id: mutation.id, mutation });
	});
	requestSync();
}
