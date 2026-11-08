const BEARER = /^Bearer (hsk_[A-Za-z0-9_-]{43})$/;

// The token from `Authorization: Bearer hsk_…`, or null when it is missing or malformed.
export function bearerToken(request: Request): string | null {
	return BEARER.exec(request.headers.get("Authorization") ?? "")?.[1] ?? null;
}

// Hex SHA-256 of the whole token, as api_tokens.token_hash stores it. The raw token never leaves here.
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
