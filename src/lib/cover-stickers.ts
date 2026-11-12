// A group's sticker: what sits on its book's cover above the name. Stored on the group as text, shared with
// everyone in it; null is the default (the hand of what the group is mostly for). private.cover_sticker()
// refuses what isSticker refuses.
//   "hand:travel"                 one of the hand drawings
//   "emoji:🇯🇵"                    one emoji, drawn as a die-cut sticker
//   "data:image/webp;base64,…"    a picture someone uploaded, made small on their device first

export const HANDS = ["food", "drinks", "stay", "travel", "groceries", "fun", "new"] as const;
export type StickerHand = (typeof HANDS)[number];

export type Sticker =
	{ kind: "hand"; hand: StickerHand } | { kind: "emoji"; emoji: string } | { kind: "image"; src: string };

// The longest sticker kept, in characters: room for a small picture, not a photo.
export const STICKER_LIMIT = 120_000;
// The most code points one emoji takes (a family, a flag with a tag sequence).
const EMOJI_POINTS = 16;
const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
// A picture character, a flag letter, or the keycap mark that makes 1️⃣ out of 1.
const PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter() : null;

// One emoji: a single character as people see it, that is a picture, not a letter or a word.
export function isEmoji(text: string): boolean {
	if (!text || /\s/.test(text) || [...text].length > EMOJI_POINTS || !PICTURE.test(text)) return false;
	return segmenter ? [...segmenter.segment(text)].length === 1 : true;
}

export function parseSticker(value: string | null | undefined): Sticker | null {
	if (!value || value.length > STICKER_LIMIT) return null;
	if (value.startsWith("hand:")) {
		const hand = value.slice(5);
		return (HANDS as readonly string[]).includes(hand) ? { kind: "hand", hand: hand as StickerHand } : null;
	}
	if (value.startsWith("emoji:")) {
		const emoji = value.slice(6);
		return isEmoji(emoji) ? { kind: "emoji", emoji } : null;
	}
	return IMAGE.test(value) ? { kind: "image", src: value } : null;
}

export const isSticker = (value: string | null | undefined): value is string => parseSticker(value) !== null;

export const handSticker = (hand: StickerHand) => `hand:${hand}`;
export const emojiSticker = (emoji: string) => `emoji:${emoji}`;

// Words in a group's name, and the stickers they bring to mind. Matched on whole words, so "bar" is not in "Barcelona".
const BY_WORD: [string[], string[]][] = [
	[
		["japan", "tokyo", "osaka", "kyoto", "hokkaido"],
		["🇯🇵", "🗾", "🍣"],
	],
	[["korea", "seoul", "busan"], ["🇰🇷"]],
	[["china", "beijing", "shanghai"], ["🇨🇳"]],
	[["hong kong"], ["🇭🇰"]],
	[["taiwan", "taipei"], ["🇹🇼"]],
	[["thailand", "bangkok", "phuket", "chiang mai"], ["🇹🇭"]],
	[["vietnam", "hanoi", "saigon"], ["🇻🇳"]],
	[["singapore"], ["🇸🇬"]],
	[["malaysia", "kuala lumpur"], ["🇲🇾"]],
	[
		["bali", "indonesia", "jakarta"],
		["🇮🇩", "🌴"],
	],
	[["philippines", "manila"], ["🇵🇭"]],
	[["india", "goa", "delhi", "mumbai"], ["🇮🇳"]],
	[
		["italy", "rome", "milan", "florence", "venice"],
		["🇮🇹", "🍝"],
	],
	[
		["france", "paris", "nice", "lyon"],
		["🇫🇷", "🥐"],
	],
	[["spain", "barcelona", "madrid", "ibiza"], ["🇪🇸"]],
	[["portugal", "lisbon", "porto"], ["🇵🇹"]],
	[["greece", "athens", "santorini", "mykonos"], ["🇬🇷"]],
	[
		["germany", "berlin", "munich"],
		["🇩🇪", "🍺"],
	],
	[["netherlands", "amsterdam"], ["🇳🇱"]],
	[["iceland", "reykjavik"], ["🇮🇸"]],
	[["uk", "london", "england", "scotland", "edinburgh"], ["🇬🇧"]],
	[["ireland", "dublin"], ["🇮🇪"]],
	[["usa", "america", "new york", "nyc", "vegas", "california", "hawaii"], ["🇺🇸"]],
	[["canada", "toronto", "vancouver", "montreal", "banff"], ["🇨🇦"]],
	[
		["mexico", "cancun", "tulum"],
		["🇲🇽", "🌮"],
	],
	[["australia", "sydney", "melbourne"], ["🇦🇺"]],
	[["new zealand"], ["🇳🇿"]],
	[
		["trip", "travel", "holiday", "holidays", "vacation", "getaway"],
		["✈️", "🧳"],
	],
	[["flight", "flights"], ["✈️"]],
	[
		["beach", "island", "islands"],
		["🏖️", "🌴"],
	],
	[
		["ski", "skiing", "snow", "snowboard"],
		["⛷️", "🏂"],
	],
	[["camp", "camping"], ["🏕️"]],
	[
		["hike", "hiking", "trek", "mountain", "mountains"],
		["🥾", "🏔️"],
	],
	[["road trip", "roadtrip", "car", "drive"], ["🚗"]],
	[["boat", "sailing", "cruise"], ["⛵"]],
	[["house", "home", "flat", "apartment", "rent", "roommates", "housemates", "flatmates"], ["🏠"]],
	[["bills", "utilities", "electricity", "internet"], ["💡"]],
	[["groceries", "grocery", "shopping"], ["🛒"]],
	[["dinner", "dinners", "lunch", "brunch", "breakfast", "food", "restaurant"], ["🍽️"]],
	[["pizza"], ["🍕"]],
	[["sushi"], ["🍣"]],
	[["bbq", "barbecue"], ["🍖"]],
	[["drinks", "bar", "pub", "beer", "beers"], ["🍻"]],
	[["wine"], ["🍷"]],
	[["coffee", "cafe"], ["☕"]],
	[
		["birthday", "bday"],
		["🎂", "🎁"],
	],
	[["party", "night out", "celebration"], ["🎉"]],
	[
		["wedding", "bachelor", "bachelorette", "hens", "stag"],
		["💍", "🥂"],
	],
	[["christmas", "xmas"], ["🎄"]],
	[["festival", "concert", "gig"], ["🎶"]],
	[["game", "games", "gaming"], ["🎮"]],
	[["football", "soccer"], ["⚽"]],
	[["basketball"], ["🏀"]],
	[["golf"], ["⛳"]],
	[["gym", "fitness"], ["🏋️"]],
	[["office", "work", "team"], ["💼"]],
	[["school", "uni", "university", "class", "college"], ["🎓"]],
	[["movie", "movies", "cinema"], ["🎬"]],
	[["baby"], ["👶"]],
	[["dog", "puppy"], ["🐶"]],
	[["cat", "kitten"], ["🐱"]],
	[["gift", "gifts", "present", "presents"], ["🎁"]],
];

// The stickers a group's name brings to mind, most specific first; none when nothing in it matches.
export function suggestStickers(name: string): string[] {
	const words = ` ${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
	const out: string[] = [];
	for (const [keys, emoji] of BY_WORD) {
		if (!keys.some((key) => words.includes(` ${key} `))) continue;
		for (const e of emoji) if (!out.includes(e)) out.push(e);
	}
	return out;
}

// A few for any group, after the name's own.
export const COMMON_STICKERS = ["✈️", "🏠", "🍽️", "🍻", "🎉", "🏖️", "🏔️", "🚗", "🛒", "🎂", "⚽", "❤️"];
