import { describe, expect, test } from "bun:test";

import {
	coverHsl,
	coverIsDeep,
	coverKey,
	coverOf,
	HUES,
	isCoverKey,
	parseCover,
	shelfCovers,
} from "@/lib/cover-colors";

describe("cover keys", () => {
	test("every cell of the board is a key, and nothing else is", () => {
		expect(isCoverKey("h0s0")).toBe(true);
		expect(isCoverKey("h17s4")).toBe(true);
		for (const key of ["h18s0", "h3s5", "h03s1", "#ff0000", "", null, 7]) expect(isCoverKey(key)).toBe(false);
		expect(parseCover("h7s2")).toEqual({ hue: 7, shade: 2 });
	});

	test("columns walk round the wheel; rows go from pale to deep", () => {
		expect(coverHsl("h0s0")).toBe("8 62% 88%");
		expect(coverHsl("h9s4")).toBe("188 56% 36%");
		expect(coverIsDeep("h4s2")).toBe(false);
		expect(coverIsDeep("h4s3")).toBe(true);
	});
});

describe("shelfCovers", () => {
	const group = (id: string, createdAt: string, coverColor: string | null = null) => ({ id, createdAt, coverColor });

	test("a chosen colour is kept, even when another group would have had it", () => {
		const covers = shelfCovers([group("a", "2026-11-01", "h2s3"), group("b", "2026-11-02", "h2s3")]);
		expect(covers.get("a")).toBe("h2s3");
		expect(covers.get("b")).toBe("h2s3");
	});

	test("groups without one each get a different colour, the same on every device", () => {
		const groups = Array.from({ length: HUES }, (_, i) =>
			group(`group-${i}`, `2026-11-${String(i + 1).padStart(2, "0")}`)
		);
		const covers = shelfCovers(groups);
		expect(new Set(covers.values()).size).toBe(HUES);
		expect(shelfCovers([...groups].reverse())).toEqual(covers);
	});

	test("a default steps past a colour someone chose", () => {
		const alone = shelfCovers([group("trip", "2026-11-02")]).get("trip")!;
		const covers = shelfCovers([group("trip", "2026-11-02"), group("home", "2026-11-01", alone)]);
		expect(covers.get("trip")).not.toBe(alone);
		expect(coverOf({ id: "trip", coverColor: null })).toBe(alone);
		expect(coverOf({ id: "trip", coverColor: coverKey(5, 4) })).toBe("h5s4");
	});
});
