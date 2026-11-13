// A group's cover colour: one cell of the colour board, stored as its key ("h7s2": hue column 7, shade row 2).
// Columns walk round the colour wheel; rows go from pale to deep. The board is the palette: a key outside it
// is not a colour, and private.cover_color() refuses the same keys.

export const HUES = 18;
export const SHADES = 5;

export type CoverKey = `h${number}s${number}`;

// The same pattern private.cover_color() checks: no padded numbers, nothing past the board.
const KEY = /^h(1[0-7]|[0-9])s([0-4])$/;

export function coverKey(hue: number, shade: number): CoverKey {
	return `h${hue}s${shade}`;
}

export function parseCover(key: string | null | undefined): { hue: number; shade: number } | null {
	const match = key ? KEY.exec(key) : null;
	if (!match) return null;
	const hue = Number(match[1]),
		shade = Number(match[2]);
	return hue < HUES && shade < SHADES ? { hue, shade } : null;
}

export function isCoverKey(key: unknown): key is CoverKey {
	return typeof key === "string" && parseCover(key) !== null;
}

// The hue in degrees of each column, starting at a warm red so the board reads red, orange, yellow, green…
export const hueOf = (hue: number) => Math.round((8 + (hue * 360) / HUES) % 360);

// Each shade row: saturation and lightness, pale paper tints at the top down to deep inks at the bottom.
const ROWS: [number, number][] = [
	[62, 88],
	[70, 78],
	[66, 66],
	[58, 50],
	[56, 36],
];

// The colour as an HSL triple ("208 79% 75%"), like the theme's tokens, so hsl() and alpha modifiers work on it.
export function coverHsl(key: CoverKey): string {
	const { hue, shade } = parseCover(key)!;
	const [s, l] = ROWS[shade];
	return `${hueOf(hue)} ${s}% ${l}%`;
}

// Deep covers take paper-coloured type; pale ones take ink.
export const coverIsDeep = (key: CoverKey) => parseCover(key)!.shade >= 3;

// Where a group with no colour of its own starts: a hue from its id, on the second row.
function hashHue(id: string) {
	let h = 2166136261;
	for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
	return (h >>> 0) % HUES;
}

// Every group's cover, so no two books on a shelf share a colour unless someone chose it: groups with a colour
// keep it; the rest, oldest first, take their own hue, or the next free one seven columns on (seven and
// eighteen share no factor, so the steps visit every column).
export function shelfCovers(groups: readonly { id: string; createdAt: string; coverColor?: string | null }[]) {
	const out = new Map<string, CoverKey>();
	const taken = new Set<string>();
	for (const g of groups) {
		if (isCoverKey(g.coverColor)) {
			out.set(g.id, g.coverColor);
			taken.add(g.coverColor);
		}
	}
	const rest = groups
		.filter((g) => !out.has(g.id))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	for (const g of rest) {
		let hue = hashHue(g.id);
		for (let step = 0; step < HUES && taken.has(coverKey(hue, 1)); step++) hue = (hue + 7) % HUES;
		const key = coverKey(hue, 1);
		out.set(g.id, key);
		taken.add(key);
	}
	return out;
}

// A colour for a new group that no book on the shelf has yet, on the second row.
export function freeCover(taken: Iterable<string>): CoverKey {
	const used = new Set(taken);
	for (let step = 0, hue = 0; step < HUES; step++, hue = (hue + 7) % HUES)
		if (!used.has(coverKey(hue, 1))) return coverKey(hue, 1);
	return coverKey(0, 1);
}

// One group's cover, on its own page: its colour, or where it starts.
export function coverOf(group: { id: string; coverColor?: string | null }): CoverKey {
	return isCoverKey(group.coverColor) ? group.coverColor : coverKey(hashHue(group.id), 1);
}
