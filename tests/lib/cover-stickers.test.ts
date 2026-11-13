import { describe, expect, test } from "bun:test";

import {
	COMMON_STICKERS,
	emojiSticker,
	handSticker,
	isEmoji,
	isSticker,
	parseSticker,
	STICKER_LIMIT,
	suggestStickers,
} from "@/lib/cover-stickers";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("cover stickers", () => {
	test("a hand, an emoji or a small picture", () => {
		expect(parseSticker("hand:travel")).toEqual({ kind: "hand", hand: "travel" });
		expect(parseSticker(handSticker("new"))).toEqual({ kind: "hand", hand: "new" });
		expect(parseSticker("emoji:🇯🇵")).toEqual({ kind: "emoji", emoji: "🇯🇵" });
		expect(parseSticker(emojiSticker("✈️"))).toEqual({ kind: "emoji", emoji: "✈️" });
		expect(parseSticker(PNG)).toEqual({ kind: "image", src: PNG });
		expect(isSticker("data:image/webp;base64,UklGRg==")).toBe(true);
		expect(isSticker("data:image/jpeg;base64,/9j/4A==")).toBe(true);
	});

	test("nothing else, as private.cover_sticker() refuses", () => {
		for (const value of [
			null,
			undefined,
			"",
			"hand:shake",
			"hand:",
			"travel",
			"emoji:",
			"emoji:hi",
			"emoji:🎉 🎉",
			"emoji:🎉🎉",
			"data:image/svg+xml;base64,PHN2Zz4=",
			"data:image/png;base64,not base64!",
			"https://example.com/sticker.png",
			`data:image/png;base64,${"A".repeat(STICKER_LIMIT)}`,
		])
			expect(isSticker(value)).toBe(false);
	});

	test("one emoji: a single picture character, however many code points it takes", () => {
		for (const emoji of ["🍣", "✈️", "🇯🇵", "👨‍👩‍👧‍👦", "🏋️", "1️⃣", "❤️"]) expect(isEmoji(emoji)).toBe(true);
		for (const text of ["a", "1", "ab", "🍣🍣", "🍣 ", " ", "😀x"]) expect(isEmoji(text)).toBe(false);
	});

	test("the common stickers are all emoji", () => {
		for (const emoji of COMMON_STICKERS) expect(isEmoji(emoji)).toBe(true);
	});
});

describe("suggestStickers", () => {
	test("a place in the name brings its flag first", () => {
		expect(suggestStickers("Japan 2027")).toEqual(["🇯🇵", "🗾", "🍣"]);
		expect(suggestStickers("Tokyo trip")).toEqual(["🇯🇵", "🗾", "🍣", "✈️", "🧳"]);
		expect(suggestStickers("Road trip to New York")).toEqual(["🇺🇸", "✈️", "🧳", "🚗"]);
	});

	test("whole words only, in any case, past punctuation", () => {
		expect(suggestStickers("Barcelona")).toEqual(["🇪🇸"]);
		expect(suggestStickers("FLAT 4B — bills")).toEqual(["🏠", "💡"]);
		expect(suggestStickers("Sam's birthday!")).toEqual(["🎂", "🎁"]);
	});

	test("nothing for a name it doesn't know", () => {
		expect(suggestStickers("53w5")).toEqual([]);
		expect(suggestStickers("")).toEqual([]);
	});

	test("every suggestion is one emoji", () => {
		const names = ["Japan", "beach", "ski", "house", "pizza", "wedding", "Christmas", "golf", "dog", "Iceland"];
		for (const emoji of names.flatMap(suggestStickers)) expect(isEmoji(emoji)).toBe(true);
	});
});
