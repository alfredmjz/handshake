import { describe, expect, test } from "bun:test";

import { isProfilePicture, PICTURE_LIMIT } from "@/lib/profile-picture";

describe("profile pictures", () => {
	test("a small PNG, JPEG or WebP as a data URL", () => {
		expect(isProfilePicture("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
		expect(isProfilePicture("data:image/jpeg;base64,/9j/4A==")).toBe(true);
		expect(isProfilePicture("data:image/webp;base64,UklGRg==")).toBe(true);
	});

	test("up to 40,000 characters, as private.profile_picture() allows", () => {
		const prefix = "data:image/png;base64,";
		expect(PICTURE_LIMIT).toBe(40_000);
		expect(isProfilePicture(prefix + "A".repeat(PICTURE_LIMIT - prefix.length))).toBe(true);
		expect(isProfilePicture(prefix + "A".repeat(PICTURE_LIMIT - prefix.length + 1))).toBe(false);
	});

	test("nothing else, as private.profile_picture() refuses", () => {
		for (const value of [
			null,
			undefined,
			"",
			7,
			"data:image/svg+xml;base64,PHN2Zz4=",
			"data:image/gif;base64,R0lGODlh",
			"https://example.com/me.png",
			"data:image/png;base64,not base64!",
			"emoji:🙂",
		]) {
			expect(isProfilePicture(value)).toBe(false);
		}
	});
});
