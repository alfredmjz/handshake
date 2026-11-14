import type { signInAsGuest } from "@/lib/auth";
import { personalCode, type Draft, type ReadyDraft } from "@/lib/join-draft";
import { joinOutcome, type OnlineOutcome } from "@/lib/online-outcome";
import type { joinWithCode, returnWithCode } from "@/lib/sync/supabase-transport";

export type JoinPorts = {
	joinWithCode: typeof joinWithCode;
	returnWithCode: typeof returnWithCode;
	signInAsGuest: typeof signInAsGuest;
	requestSync: () => void;
	// A getter: reading `sessionStorage` can itself throw, so it is resolved inside each try.
	storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
};

// Joining with a group code, or getting back in with a personal code.
export type Way = { kind: "join"; draft: ReadyDraft } | { kind: "return" };

export type JoinResult = OnlineOutcome | { kind: "in"; groupId: string; showGuestCode: boolean };

// One per screen mount. Signed out, the way in is stashed across the account or guest step (the URL stays);
// back signed in, restore() hands it over once and the screen finishes it with go(). Without storage the
// choice is simply asked again.
export function createJoinFlow(ports: JoinPorts, code: string) {
	const keyOf = (kind: Way["kind"]) => `handshake.${kind}.${code}`;
	let restored: { draft: Draft | null; returning: boolean } | null = null;
	let running: Promise<JoinResult> | null = null;

	function take<T>(kind: Way["kind"], read: (raw: string | null) => T, fallback: T): T {
		try {
			const store = ports.storage();
			const raw = store.getItem(keyOf(kind));
			store.removeItem(keyOf(kind));
			return read(raw);
		} catch {
			return fallback;
		}
	}

	function stash(way: Way) {
		try {
			ports.storage().setItem(keyOf(way.kind), way.kind === "join" ? JSON.stringify(way.draft) : "1");
		} catch {}
	}

	async function run(way: Way, asGuest: boolean): Promise<JoinResult> {
		try {
			const choice = way.kind === "join" ? way.draft.choice : null;
			const groupId =
				way.kind === "return"
					? await ports.returnWithCode(code)
					: await ports.joinWithCode({
							code,
							claimMemberId: choice?.kind === "new" ? undefined : (choice?.memberId ?? undefined),
							displayName: choice?.kind === "new" ? way.draft.name.trim() : undefined,
							personalCode: choice?.kind === "back" ? (personalCode(way.draft.personalCode) ?? undefined) : undefined,
						});
			ports.requestSync();
			return { kind: "in", groupId, showGuestCode: asGuest && choice !== null && choice.kind !== "back" };
		} catch (error) {
			return joinOutcome(error, way.kind);
		}
	}

	return {
		// Render-safe: the stash is read and cleared on the first call; later calls give the same answer.
		restore() {
			restored ??= {
				draft: take("join", (raw) => (raw ? (JSON.parse(raw) as Draft) : null), null),
				returning: take("return", (raw) => raw === "1", false),
			};
			return restored;
		},
		stash,
		// While a join or return is in flight, asking again gives that same attempt.
		go(way: Way, asGuest = false): Promise<JoinResult> {
			if (!running) running = run(way, asGuest).finally(() => (running = null));
			return running;
		},
		// Null once the guest login exists: the screen remounts signed in and restore() finishes it.
		async viaGuest(way: Way): Promise<JoinResult | null> {
			stash(way);
			try {
				await ports.signInAsGuest();
				return null;
			} catch (e) {
				const description = e instanceof Error ? e.message : undefined;
				return { kind: "toast", title: "Couldn't continue as a guest", description };
			}
		},
	};
}
