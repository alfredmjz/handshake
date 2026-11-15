import { codeKind, normaliseCode } from "@/lib/code-format";

// Which way in: a name-only person, someone new, or a guest coming back with their personal code.
export type Choice = { kind: "claim"; memberId: string } | { kind: "new" } | { kind: "back"; memberId: string | null };

export type Draft = { choice: Choice | null; name: string; personalCode: string };
export type ReadyDraft = Draft & { choice: Choice };

type Names = { unclaimed: readonly { displayName: string }[]; returning: readonly { displayName: string }[] };

export function personalCode(input: string): string | null {
	const code = normaliseCode(input);
	return code && codeKind(code) === "personal" ? code : null;
}

export function draftReady(draft: Draft): draft is ReadyDraft {
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
