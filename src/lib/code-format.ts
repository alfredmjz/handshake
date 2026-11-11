// Group codes and personal codes: 6 characters from an alphabet without lookalikes (no 0/O, 1/I/L), stored
// without the dash, shown as "HX7-K2P". The same rules as private.normalise_code on the server.
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

// What someone typed or pasted (any case, dash and spaces ignored, or a whole /join/ link) as a stored code,
// or null when it can't be one.
export function normaliseCode(input: string): string | null {
	const fromLink = /\/join\/([^/?#]*)/.exec(input)?.[1];
	const code = (fromLink ?? input).replace(/[\s-]/g, "").toUpperCase();
	return CODE.test(code) ? code : null;
}

// "HX7K2P" → "HX7-K2P".
export function formatCode(code: string): string {
	return `${code.slice(0, 3)}-${code.slice(3)}`;
}

// The path the group's link opens: "/join/HX7K2P".
export function joinPath(code: string): string {
	return `/join/${code}`;
}
