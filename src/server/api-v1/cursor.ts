// The payments feed cursor (ADR-004): base64url JSON {"v":1,"scope":"all"|"<groupId>","groups":{id:version}}.
// Opaque to Pholio; a cursor only works on the endpoint that issued it.

export type CursorScope = "all" | string;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function isUuid(value: string): boolean {
	return UUID.test(value);
}

function toBase64Url(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
	const binary = atob(padded);
	return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeCursor(scope: CursorScope, groups: Record<string, number>): string {
	return toBase64Url(JSON.stringify({ v: 1, scope, groups }));
}

// The cursor's groups, or null when it isn't one this endpoint issued.
export function decodeCursor(text: string, scope: CursorScope): Record<string, number> | null {
	if (!BASE64URL.test(text)) return null;
	try {
		const value = JSON.parse(fromBase64Url(text)) as unknown;
		if (typeof value !== "object" || value === null) return null;
		const { v, scope: issuedFor, groups } = value as { v?: unknown; scope?: unknown; groups?: unknown };
		if (v !== 1 || issuedFor !== scope || typeof groups !== "object" || groups === null || Array.isArray(groups)) {
			return null;
		}
		const entries = Object.entries(groups);
		const valid = entries.every(
			([id, version]) => isUuid(id) && typeof version === "number" && Number.isSafeInteger(version) && version >= 0
		);
		return valid ? (Object.fromEntries(entries) as Record<string, number>) : null;
	} catch {
		return null;
	}
}
