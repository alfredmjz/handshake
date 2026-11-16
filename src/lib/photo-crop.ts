// Where a photo sits in the round frame: a square of the photo, chosen by zooming in and dragging. The centre is in
// the photo's own pixels; zoom 1 is the largest square that fits (the middle square to start with).

export type ImageSize = { width: number; height: number };
export type Crop = { zoom: number; cx: number; cy: number };
export type Square = { x: number; y: number; side: number };

export const MAX_ZOOM = 4;

const sideOf = (size: ImageSize, zoom: number) => Math.min(size.width, size.height) / zoom;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// The zoom held to 1 to MAX_ZOOM, and the centre moved just enough that the square stays inside the photo.
export function clampCrop(size: ImageSize, crop: Crop): Crop {
	const zoom = clamp(crop.zoom, 1, MAX_ZOOM);
	const half = sideOf(size, zoom) / 2;
	return { zoom, cx: clamp(crop.cx, half, size.width - half), cy: clamp(crop.cy, half, size.height - half) };
}

export const startCrop = (size: ImageSize): Crop => ({ zoom: 1, cx: size.width / 2, cy: size.height / 2 });

// The part of the photo in the frame.
export function cropSquare(size: ImageSize, crop: Crop): Square {
	const { zoom, cx, cy } = clampCrop(size, crop);
	const side = sideOf(size, zoom);
	return { x: cx - side / 2, y: cy - side / 2, side };
}

// Dragging the photo by (dx, dy) on a frame `frame` px across: the photo follows the pointer, so the centre moves
// the other way.
export function panCrop(size: ImageSize, crop: Crop, dx: number, dy: number, frame: number): Crop {
	const scale = frame / sideOf(size, clampCrop(size, crop).zoom);
	return clampCrop(size, { ...crop, cx: crop.cx - dx / scale, cy: crop.cy - dy / scale });
}

export const zoomCrop = (size: ImageSize, crop: Crop, zoom: number): Crop => clampCrop(size, { ...crop, zoom });

// How to draw the whole photo so the crop fills a frame `frame` px across: its size and offset in frame px.
export function placeInFrame(size: ImageSize, crop: Crop, frame: number) {
	const square = cropSquare(size, crop);
	const scale = frame / square.side;
	return { width: size.width * scale, height: size.height * scale, left: -square.x * scale, top: -square.y * scale };
}
