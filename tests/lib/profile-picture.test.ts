import { describe, expect, test } from "bun:test";

import {
	chosenSlot,
	faceChoice,
	isPhoto,
	isProfilePicture,
	parseProfilePicture,
	PICTURE_LIMIT,
} from "@/lib/profile-picture";

describe("profile pictures", () => {
	test("one of the 30 drawn faces, by its slot", () => {
		expect(parseProfilePicture("face:0")).toEqual({ kind: "face", slot: 0 });
		expect(parseProfilePicture(faceChoice(29))).toEqual({ kind: "face", slot: 29 });
		expect(chosenSlot("face:12")).toBe(12);
		expect(isPhoto("face:12")).toBe(false);
	});

	test("or a small PNG, JPEG or WebP as a data URL", () => {
		expect(parseProfilePicture("data:image/png;base64,iVBORw0KGgo=")).toEqual({
			kind: "photo",
			src: "data:image/png;base64,iVBORw0KGgo=",
		});
		expect(isPhoto("data:image/jpeg;base64,/9j/4A==")).toBe(true);
		expect(isProfilePicture("data:image/webp;base64,UklGRg==")).toBe(true);
		expect(chosenSlot("data:image/webp;base64,UklGRg==")).toBeNull();
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
			"face:30",
			"face:07",
			"face:-1",
			"face:",
			"face:1.5",
			"data:image/svg+xml;base64,PHN2Zz4=",
			"data:image/gif;base64,R0lGODlh",
			"https://example.com/me.png",
			"data:image/png;base64,not base64!",
			"emoji:🙂",
		]) {
			expect(isProfilePicture(value)).toBe(false);
		}
		expect(chosenSlot(null)).toBeNull();
	});
});
