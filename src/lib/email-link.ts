export const EMAIL_LINK_PATH = "/sign-in/link";

// The sign-in email's button: /sign-in/link?token_hash=…&type=email. The same one-use, one-hour code as the digits,
// hashed, so the link signs in on whatever device opens it. Mail scanners that fetch links don't run the page,
// so they can't use it up.
export function emailLinkIn(search: string): { tokenHash: string; type: "email" } | null {
	const params = new URLSearchParams(search);
	const tokenHash = params.get("token_hash")?.trim();
	if (!tokenHash || !/^[\w-]{16,128}$/.test(tokenHash)) return null;
	return params.get("type") === "email" ? { tokenHash, type: "email" } : null;
}
