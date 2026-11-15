import { describe, expect, test } from "bun:test";

import { createSyncController, type SyncDevice } from "@/lib/sync/controller";
import type { SyncOutcome, SyncStore, SyncTransport } from "@/lib/sync/engine";
import type { RejectedMutation } from "@/lib/sync/types";

const NOW = "2026-11-13T10:00:00.000Z";
const store = {} as SyncStore;
const transport = {} as SyncTransport;

function fakeDevice() {
	const connection = new Set<() => void>();
	const visibility = new Set<() => void>();
	const timers = new Map<number, Set<() => void>>();
	const device: SyncDevice & { online: boolean; visible: boolean } = {
		online: true,
		visible: true,
		isOnline: () => device.online,
		isVisible: () => device.visible,
		onConnectionChange: (listener) => {
			connection.add(listener);
			return () => connection.delete(listener);
		},
		onVisibilityChange: (listener) => {
			visibility.add(listener);
			return () => visibility.delete(listener);
		},
		every: (ms, tick) => {
			const ticks = timers.get(ms) ?? new Set();
			ticks.add(tick);
			timers.set(ms, ticks);
			return () => ticks.delete(tick);
		},
		now: () => NOW,
	};
	return {
		device,
		goOnline: () => ((device.online = true), connection.forEach((l) => l())),
		goOffline: () => ((device.online = false), connection.forEach((l) => l())),
		show: () => ((device.visible = true), visibility.forEach((l) => l())),
		hide: () => ((device.visible = false), visibility.forEach((l) => l())),
		tick: (ms: number) => timers.get(ms)?.forEach((t) => t()),
		listening: () => connection.size + visibility.size + [...timers.values()].reduce((n, t) => n + t.size, 0),
	};
}

// Each sync waits until the test finishes it, so a request can arrive while one is running.
function fakeSync() {
	const waiting: { finish: (outcome?: Partial<SyncOutcome>) => void; fail: (error: Error) => void }[] = [];
	const sync = () =>
		new Promise<SyncOutcome>((resolve, reject) => {
			waiting.push({
				finish: (outcome) => resolve({ pushed: 0, rejected: [], ...outcome }),
				fail: reject,
			});
		});
	return {
		sync,
		calls: () => waiting.length,
		finish: async (outcome?: Partial<SyncOutcome>) => {
			waiting.at(-1)!.finish(outcome);
			await settle();
		},
		fail: async (error: Error) => {
			waiting.at(-1)!.fail(error);
			await settle();
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
	const device = fakeDevice();
	const sync = fakeSync();
	const rejected: RejectedMutation[][] = [];
	const controller = createSyncController({ device: device.device, sync: sync.sync });
	const start = () => controller.start(store, transport, (r) => rejected.push(r));
	return { device, sync, controller, rejected, start };
}

describe("sync controller", () => {
	test("syncs on start and reports idle with the time once done", async () => {
		const { sync, controller, start } = setup();
		start();
		expect(sync.calls()).toBe(1);
		expect(controller.status().state).toBe("syncing");

		await sync.finish();

		expect(controller.status()).toEqual({ state: "idle", lastSyncedAt: NOW, error: null });
	});

	test("a request during a running sync runs once more after it, however many arrive", async () => {
		const { sync, controller, start } = setup();
		start();
		controller.requestSync();
		controller.requestSync();
		expect(sync.calls()).toBe(1);

		await sync.finish();
		expect(sync.calls()).toBe(2);

		await sync.finish();
		expect(sync.calls()).toBe(2);
		expect(controller.status().state).toBe("idle");
	});

	test("offline skips the sync and says so", async () => {
		const { device, sync, controller, start } = setup();
		device.device.online = false;
		start();
		await settle();

		expect(sync.calls()).toBe(0);
		expect(controller.status().state).toBe("offline");
	});

	test("coming back online syncs", async () => {
		const { device, sync, controller, start } = setup();
		device.device.online = false;
		start();
		await settle();

		device.goOnline();

		expect(sync.calls()).toBe(1);
		await sync.finish();
		expect(controller.status().state).toBe("idle");
	});

	test("going offline shows offline", async () => {
		const { device, sync, controller, start } = setup();
		start();
		await sync.finish();

		device.goOffline();
		await settle();

		expect(sync.calls()).toBe(1);
		expect(controller.status().state).toBe("offline");
	});

	test("reopening the app syncs; hiding it does not", async () => {
		const { device, sync, start } = setup();
		start();
		await sync.finish();

		device.hide();
		expect(sync.calls()).toBe(1);

		device.show();
		expect(sync.calls()).toBe(2);
	});

	test("syncs once a minute while visible", async () => {
		const { device, sync, start } = setup();
		start();
		await sync.finish();

		device.tick(60_000);
		expect(sync.calls()).toBe(2);
		await sync.finish();

		device.device.visible = false;
		device.tick(60_000);
		expect(sync.calls()).toBe(2);
	});

	test("hands rejected changes to the caller", async () => {
		const { sync, rejected, start } = setup();
		start();
		await sync.finish({ rejected: [{ id: "m1", reason: "No" }] });

		expect(rejected).toEqual([[{ id: "m1", reason: "No" }]]);
	});

	test("a failed sync shows the error while online, offline otherwise", async () => {
		const { device, sync, controller, start } = setup();
		start();
		await sync.fail(new Error("Server down"));
		expect(controller.status()).toMatchObject({ state: "error", error: "Server down" });

		controller.requestSync();
		device.device.online = false;
		await sync.fail(new Error("Network"));
		expect(controller.status().state).toBe("offline");
	});

	test("stopping drops every trigger and resets the status", async () => {
		const { device, sync, controller, start } = setup();
		const stop = start();
		await sync.finish();

		stop();

		expect(device.listening()).toBe(0);
		expect(controller.status()).toEqual({ state: "idle", lastSyncedAt: null, error: null });
		controller.requestSync();
		device.tick(60_000);
		expect(sync.calls()).toBe(1);
	});

	test("subscribers hear each status change", async () => {
		const { sync, controller, start } = setup();
		const heard: string[] = [];
		const unsubscribe = controller.subscribe(() => heard.push(controller.status().state));
		start();
		await sync.finish();
		unsubscribe();
		controller.requestSync();

		expect(heard).toEqual(["syncing", "idle"]);
	});
});
