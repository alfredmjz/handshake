export const NEEDS_CONNECTION = "Needs a connection";
export const DOESNT_WORK = "This code doesn't work";
export const OFFLINE_SIGN_IN = { title: "You're offline", description: "Signing in needs a connection." };

export type JoinContext = "join" | "return";

// "gone": the code no longer works, show `title` and leave the screen; "inline": text under the form;
// "toast": a toast with an optional description.
export type OnlineOutcome =
	| { kind: "gone"; title: string }
	| { kind: "inline"; message: string }
	| { kind: "toast"; title: string; description: string | undefined };

type Coded = Error & { code: string };

// By name, not instanceof: importing the transport pulls in the Supabase client, which needs env keys.
function transportCode(error: unknown): string | null {
	return error instanceof Error && error.name === "TransportError" ? (error as Coded).code : null;
}

export function isServerError(error: unknown): boolean {
	return transportCode(error) !== null;
}

// A lost connection: the transport's failed fetch, or Supabase auth's. Auth raises AuthRetryableFetchError with
// status 0 only when the fetch itself failed; with a 5xx status it is a server error and keeps its message.
function lostConnection(error: unknown): boolean {
	if (transportCode(error) === "network") return true;
	return (
		error instanceof Error && error.name === "AuthRetryableFetchError" && (error as { status?: number }).status === 0
	);
}

// A failure toast's arguments: a lost connection reads "Needs a connection", anything else keeps its message.
export function failureNotice(error: unknown, title: string): [string, { description: string | undefined }] {
	return [
		title,
		{ description: lostConnection(error) ? NEEDS_CONNECTION : error instanceof Error ? error.message : undefined },
	];
}

export function previewFailure(error: unknown): "gone" | "failed" {
	return transportCode(error) === "HS404" ? "gone" : "failed";
}

// Joining with a group code ("join") and getting back in with a personal code ("return") word some codes differently.
export function joinOutcome(error: unknown, context: JoinContext): OnlineOutcome {
	const code = transportCode(error);
	const message = error instanceof Error ? error.message : "";
	if (code === "HS404") return { kind: "gone", title: DOESNT_WORK };
	if (context === "join") {
		if (code === "HS409" || code === "HS422") return { kind: "inline", message };
		if (code === "23514") return { kind: "inline", message: "That name is too long" };
	} else if (code === "HS422") return { kind: "inline", message };
	if (code === "network") return { kind: "inline", message: "Joining needs a connection." };
	return {
		kind: "toast",
		title: context === "join" ? "Couldn't join" : "Couldn't get back in",
		description: message || undefined,
	};
}
