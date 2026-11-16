import { describe, expect, test } from "bun:test";

import {
	clampCrop,
	cropSquare,
	MAX_ZOOM,
	MIN_ZOOM,
	panCrop,
	placeInFrame,
	startCrop,
	zoomCrop,
} from "@/lib/photo-crop";

// A landscape photo: 900 by 600, so its largest square is 600 across.
const WIDE = { width: 900, height: 600 };

describe("photo crop", () => {
	test("starts on the middle square", () => {
		expect(cropSquare(WIDE, startCrop(WIDE))).toEqual({ x: 150, y: 0, side: 600 });
	});

	test("zooming in takes a smaller square around the same centre", () => {
		expect(cropSquare(WIDE, zoomCrop(WIDE, startCrop(WIDE), 2))).toEqual({ x: 300, y: 150, side: 300 });
	});

	test("zoom stays between the least and the most", () => {
		expect(MIN_ZOOM).toBe(0.5);
		expect(zoomCrop(WIDE, startCrop(WIDE), 0.1).zoom).toBe(MIN_ZOOM);
		expect(zoomCrop(WIDE, startCrop(WIDE), 99).zoom).toBe(MAX_ZOOM);
	});

	test("zoomed out, the square is bigger than the photo, which sits inside it", () => {
		// Zoom 0.5: a 1,200 square around the photo's centre (450, 300).
		expect(cropSquare(WIDE, zoomCrop(WIDE, startCrop(WIDE), 0.5))).toEqual({ x: -150, y: -300, side: 1200 });
		// Dragged far right, the photo stops at the frame's right edge: its 900 width ends where the 1,200 square does.
		const right = panCrop(WIDE, zoomCrop(WIDE, startCrop(WIDE), 0.5), 1000, 0, 150);
		expect(cropSquare(WIDE, right)).toEqual({ x: -300, y: -300, side: 1200 });
		// Drawn in a 150px frame, the photo is 112.5 by 75, with the background showing around it.
		expect(placeInFrame(WIDE, zoomCrop(WIDE, startCrop(WIDE), 0.5), 150)).toEqual({
			width: 112.5,
			height: 75,
			left: 18.75,
			top: 37.5,
		});
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
