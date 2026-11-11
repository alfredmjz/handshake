// Codes use an alphabet without lookalikes (no 0/O, 1/I/L) and are stored without the dash. A group code is
// 6 characters, shown as "HX7-K2P"; a guest's personal code is 8, shown as "7KQM-2DXH". The same rules as
// private.normalise_code on the server.
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const CODE = /^(?:[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}|[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})$/;

export type CodeKind = "group" | "personal";

// What someone typed or pasted (any case, dash and spaces ignored, or a whole /join/ link) as a stored code
// of either kind, or null when it can't be one.
export function normaliseCode(input: string): string | null {
	const fromLink = /\/join\/([^/?#]*)/.exec(input)?.[1];
	const code = (fromLink ?? input).replace(/[\s-]/g, "").toUpperCase();
	return CODE.test(code) ? code : null;
}

// For a code from normaliseCode: the length tells them apart.
export function codeKind(code: string): CodeKind {
	return code.length === 8 ? "personal" : "group";
}

export function readCode(input: string): { kind: CodeKind; code: string } | null {
	const code = normaliseCode(input);
	return code ? { kind: codeKind(code), code } : null;
}

// "HX7K2P" → "HX7-K2P", "7KQM2DXH" → "7KQM-2DXH".
export function formatCode(code: string): string {
	const half = code.length / 2;
	return `${code.slice(0, half)}-${code.slice(half)}`;
}

// The path a code's link opens: "/join/HX7K2P" (or a personal code).
export function joinPath(code: string): string {
	return `/join/${code}`;
}
