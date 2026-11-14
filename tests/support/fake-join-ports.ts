import type { JoinPorts } from "@/lib/join-flow";

type Call = { name: "join" | "return" | "guest" | "sync"; args?: unknown };

// Each server call waits until the test settles it, so a test can look at the flow while one is in flight.
export function fakeJoinPorts() {
	const calls: Call[] = [];
	const data = new Map<string, string>();
	const pending: { resolve: (groupId: string) => void; reject: (error: unknown) => void }[] = [];
	let storageBroken = false;
	let guestError: unknown = null;

	const wait = (name: Call["name"], args: unknown) =>
		new Promise<string>((resolve, reject) => {
			calls.push({ name, args });
			pending.push({ resolve, reject });
		});

	const ports: JoinPorts = {
		joinWithCode: (args) => wait("join", args),
		returnWithCode: (code) => wait("return", code),
		signInAsGuest: async () => {
			calls.push({ name: "guest" });
			if (guestError) throw guestError;
		},
		requestSync: () => void calls.push({ name: "sync" }),
		storage: () => {
			if (storageBroken) throw new Error("SecurityError");
			return {
				getItem: (k) => data.get(k) ?? null,
				setItem: (k, v) => void data.set(k, v),
				removeItem: (k) => void data.delete(k),
			};
		},
	};

	return {
		ports,
		calls,
		data,
		names: () => calls.map((c) => c.name),
		breakStorage: () => void (storageBroken = true),
		failGuest: (error: unknown) => void (guestError = error),
		succeed: (groupId: string) => pending.shift()!.resolve(groupId),
		fail: (error: unknown) => pending.shift()!.reject(error),
	};
}
