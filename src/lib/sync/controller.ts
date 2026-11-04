import { useSyncExternalStore } from "react";

import { syncOnce, type SyncStore, type SyncTransport } from "@/lib/sync/engine";
import type { RejectedMutation } from "@/lib/sync/types";

export type SyncStatus = {
	state: "idle" | "syncing" | "offline" | "error";
	lastSyncedAt: string | null;
	error: string | null;
};

type Session = { store: SyncStore; transport: SyncTransport; onRejected: (rejected: RejectedMutation[]) => void };

const BACKGROUND_SYNC_MS = 60_000;
const INITIAL_STATUS: SyncStatus = { state: "idle", lastSyncedAt: null, error: null };

let status = INITIAL_STATUS;
const listeners = new Set<() => void>();
let session: Session | null = null;
let running = false;
let runAgain = false;

function setStatus(next: Partial<SyncStatus>) {
	status = { ...status, ...next };
	listeners.forEach((listener) => listener());
}

// There is no Realtime: sync on start, after each local change, when the device comes back online or
// the app is reopened, and once a minute while it is open.
export function startSync(store: SyncStore, transport: SyncTransport, onRejected: Session["onRejected"]) {
	session = { store, transport, onRejected };
	const syncIfVisible = () => {
		if (document.visibilityState === "visible") requestSync();
	};
	window.addEventListener("online", requestSync);
	window.addEventListener("offline", requestSync);
	document.addEventListener("visibilitychange", syncIfVisible);
	const timer = window.setInterval(syncIfVisible, BACKGROUND_SYNC_MS);
	requestSync();

	return () => {
		session = null;
		window.removeEventListener("online", requestSync);
		window.removeEventListener("offline", requestSync);
		document.removeEventListener("visibilitychange", syncIfVisible);
		window.clearInterval(timer);
		setStatus(INITIAL_STATUS);
	};
}

export function requestSync() {
	if (!session) return;
	if (running) {
		runAgain = true;
		return;
	}
	void run(session);
}

async function run(current: Session) {
	running = true;
	try {
		if (!navigator.onLine) {
			setStatus({ state: "offline" });
			return;
		}
		setStatus({ state: "syncing", error: null });
		const outcome = await syncOnce(current.store, current.transport);
		if (outcome.rejected.length > 0) current.onRejected(outcome.rejected);
		setStatus({ state: "idle", lastSyncedAt: new Date().toISOString() });
	} catch (error) {
		setStatus(
			navigator.onLine
				? { state: "error", error: error instanceof Error ? error.message : String(error) }
				: { state: "offline" }
		);
	} finally {
		running = false;
		if (runAgain) {
			runAgain = false;
			requestSync();
		}
	}
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useSyncStatus(): SyncStatus {
	return useSyncExternalStore(subscribe, () => status);
}
