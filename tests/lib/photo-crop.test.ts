import { describe, expect, test } from "bun:test";

import { clampCrop, cropSquare, MAX_ZOOM, panCrop, placeInFrame, startCrop, zoomCrop } from "@/lib/photo-crop";

// A landscape photo: 900 by 600, so its largest square is 600 across.
const WIDE = { width: 900, height: 600 };

describe("photo crop", () => {
	test("starts on the middle square", () => {
		expect(cropSquare(WIDE, startCrop(WIDE))).toEqual({ x: 150, y: 0, side: 600 });
	});

	test("zooming in takes a smaller square around the same centre", () => {
		expect(cropSquare(WIDE, zoomCrop(WIDE, startCrop(WIDE), 2))).toEqual({ x: 300, y: 150, side: 300 });
	});

	test("zoom stays between 1 and the most", () => {
		expect(zoomCrop(WIDE, startCrop(WIDE), 0.5).zoom).toBe(1);
		expect(zoomCrop(WIDE, startCrop(WIDE), 99).zoom).toBe(MAX_ZOOM);
	});

	test("dragging moves the photo with the pointer, so the square moves the other way", () => {
		// A 150px frame shows 600 photo pixels, so 1 frame px is 4 photo px: dragging 10px right shows 40px further left.
		const moved = panCrop(WIDE, startCrop(WIDE), 10, 0, 150);
		expect(cropSquare(WIDE, moved)).toEqual({ x: 110, y: 0, side: 600 });
	});

	test("the square never leaves the photo", () => {
		expect(cropSquare(WIDE, panCrop(WIDE, startCrop(WIDE), 1000, 1000, 150))).toEqual({ x: 0, y: 0, side: 600 });
		expect(cropSquare(WIDE, panCrop(WIDE, startCrop(WIDE), -1000, -1000, 150))).toEqual({ x: 300, y: 0, side: 600 });
		expect(clampCrop(WIDE, { zoom: 2, cx: 0, cy: 0 })).toEqual({ zoom: 2, cx: 150, cy: 150 });
	});

	test("the whole photo is drawn so the square fills the frame", () => {
		expect(placeInFrame(WIDE, startCrop(WIDE), 150)).toEqual({ width: 225, height: 150, left: -37.5, top: -0 });
	});
});
