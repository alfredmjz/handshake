import { codeKind, normaliseCode } from "@/lib/code-format";

// Which way in: a name-only person, someone new, or a guest coming back with their personal code.
export type Choice = { kind: "claim"; memberId: string } | { kind: "new" } | { kind: "back"; memberId: string | null };

export type Draft = { choice: Choice | null; name: string; personalCode: string };

type Names = { unclaimed: readonly { displayName: string }[]; returning: readonly { displayName: string }[] };

type Backing = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// A getter lets the caller pass `() => sessionStorage`: reading that global can itself throw, so it is resolved inside each try.
export type Store = Backing | (() => Backing);

const open = (store: Store): Backing => (typeof store === "function" ? store() : store);

export function personalCode(input: string): string | null {
	const code = normaliseCode(input);
	return code && codeKind(code) === "personal" ? code : null;
}

export function draftReady(draft: Draft): boolean {
	const { choice } = draft;
	if (!choice) return false;
	if (choice.kind === "new") return draft.name.trim().length > 0;
	if (choice.kind === "back") return choice.memberId !== null && personalCode(draft.personalCode) !== null;
	return true;
}

export function nameTaken(preview: Names, name: string): boolean {
	const key = name.trim().toLowerCase();
	return [...preview.unclaimed, ...preview.returning].some((p) => p.displayName.trim().toLowerCase() === key);
}

export function nameClash(draft: Draft, preview: Names): boolean {
	return draft.choice?.kind === "new" && draft.name.trim().length > 0 && nameTaken(preview, draft.name);
}

// Signed out, the choice is kept across the account or guest step (the URL stays); back signed in, the
// join screen finishes it once.
const draftKey = (code: string) => `handshake.join.${code}`;
const returnKey = (code: string) => `handshake.return.${code}`;

export function stashDraft(store: Store, code: string, draft: Draft) {
	try {
		open(store).setItem(draftKey(code), JSON.stringify(draft));
	} catch {
		// Without storage the choice is simply asked again.
	}
}

export function takeDraft(store: Store, code: string): Draft | null {
	try {
		const raw = open(store).getItem(draftKey(code));
		open(store).removeItem(draftKey(code));
		return raw ? (JSON.parse(raw) as Draft) : null;
	} catch {
		return null;
	}
}

// Signed out, "Continue as guest" remembers to finish here once the guest login exists.
export function stashReturn(store: Store, code: string) {
	try {
		open(store).setItem(returnKey(code), "1");
	} catch {
		// Without storage the button is simply tapped again.
	}
}

export function takeReturn(store: Store, code: string): boolean {
	try {
		const wanted = open(store).getItem(returnKey(code)) === "1";
		open(store).removeItem(returnKey(code));
		return wanted;
	} catch {
		return false;
	}
}
