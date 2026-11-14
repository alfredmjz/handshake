import { useSyncExternalStore } from "react";

import { syncOnce, type SyncStore, type SyncTransport } from "@/lib/sync/engine";
import type { RejectedMutation } from "@/lib/sync/types";

export type SyncStatus = {
	state: "idle" | "syncing" | "offline" | "error";
	lastSyncedAt: string | null;
	error: string | null;
};

// What the controller needs from the device it runs on. Each subscription returns its unsubscribe.
export type SyncDevice = {
	isOnline(): boolean;
	isVisible(): boolean;
	onConnectionChange(listener: () => void): () => void;
	onVisibilityChange(listener: () => void): () => void;
	every(ms: number, tick: () => void): () => void;
	now(): string;
};

export const browserDevice: SyncDevice = {
	isOnline: () => navigator.onLine,
	isVisible: () => document.visibilityState === "visible",
	onConnectionChange: (listener) => {
		window.addEventListener("online", listener);
		window.addEventListener("offline", listener);
		return () => {
			window.removeEventListener("online", listener);
			window.removeEventListener("offline", listener);
		};
	},
	onVisibilityChange: (listener) => {
		document.addEventListener("visibilitychange", listener);
		return () => document.removeEventListener("visibilitychange", listener);
	},
	every: (ms, tick) => {
		const timer = window.setInterval(tick, ms);
		return () => window.clearInterval(timer);
	},
	now: () => new Date().toISOString(),
};

export type SyncControllerDeps = { device: SyncDevice; sync: typeof syncOnce };

type OnRejected = (rejected: RejectedMutation[]) => void;
type Session = { store: SyncStore; transport: SyncTransport; onRejected: OnRejected };

const BACKGROUND_SYNC_MS = 60_000;
const INITIAL_STATUS: SyncStatus = { state: "idle", lastSyncedAt: null, error: null };

export function createSyncController({ device, sync }: SyncControllerDeps = { device: browserDevice, sync: syncOnce }) {
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
	function start(store: SyncStore, transport: SyncTransport, onRejected: OnRejected) {
		session = { store, transport, onRejected };
		const request = () => requestSync();
		const syncIfVisible = () => {
			if (device.isVisible()) requestSync();
		};
		const stops = [
			device.onConnectionChange(request),
			device.onVisibilityChange(syncIfVisible),
			device.every(BACKGROUND_SYNC_MS, syncIfVisible),
		];
		requestSync();

		return () => {
			session = null;
			stops.forEach((stop) => stop());
			setStatus(INITIAL_STATUS);
		};
	}

	function requestSync() {
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
			if (!device.isOnline()) {
				setStatus({ state: "offline" });
				return;
			}
			setStatus({ state: "syncing", error: null });
			const outcome = await sync(current.store, current.transport);
			if (outcome.rejected.length > 0) current.onRejected(outcome.rejected);
			setStatus({ state: "idle", lastSyncedAt: device.now() });
		} catch (error) {
			setStatus(
				device.isOnline()
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

	return { start, requestSync, subscribe, status: () => status };
}

const controller = createSyncController();

export const startSync = controller.start;

export function requestSync() {
	controller.requestSync();
}

export function useSyncStatus(): SyncStatus {
	return useSyncExternalStore(controller.subscribe, controller.status);
}
