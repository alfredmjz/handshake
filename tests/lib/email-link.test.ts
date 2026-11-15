import { describe, expect, test } from "bun:test";

import { emailLinkIn } from "@/lib/email-link";

const HASH = "pkce_3f9a1c2b7e4d5a6b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d";

describe("emailLinkIn", () => {
	test("takes the token hash from the email's link", () => {
		expect(emailLinkIn(`?token_hash=${HASH}&type=email`)).toEqual({ tokenHash: HASH, type: "email" });
		expect(emailLinkIn(`?type=email&token_hash=${HASH}`)).toEqual({ tokenHash: HASH, type: "email" });
	});

	test("refuses a link without a usable hash or of another type", () => {
		expect(emailLinkIn("")).toBeNull();
		expect(emailLinkIn("?type=email")).toBeNull();
		expect(emailLinkIn(`?token_hash=${HASH}`)).toBeNull();
		expect(emailLinkIn(`?token_hash=${HASH}&type=email_change`)).toBeNull();
		expect(emailLinkIn(`?token_hash=${HASH}&type=recovery`)).toBeNull();
		expect(emailLinkIn("?token_hash=short&type=email")).toBeNull();
		expect(emailLinkIn("?token_hash=has%20space%20inside%20it%20here&type=email")).toBeNull();
	});
});
