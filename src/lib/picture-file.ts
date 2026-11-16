import { isSticker, STICKER_LIMIT } from "@/lib/cover-stickers";
import type { Square } from "@/lib/photo-crop";
import { isPhoto } from "@/lib/profile-picture";

type Try = { edge: number; quality: number };
type Rect = { x: number; y: number; width: number; height: number };

// Each try draws the picture smaller and plainer, until it fits.
const STICKER_TRIES: readonly Try[] = [
	{ edge: 256, quality: 0.85 },
	{ edge: 192, quality: 0.75 },
	{ edge: 128, quality: 0.7 },
];
const PROFILE_TRIES: readonly Try[] = [
	{ edge: 192, quality: 0.85 },
	{ edge: 160, quality: 0.75 },
	{ edge: 128, quality: 0.7 },
];

// Part of a picture drawn into a box of at most `edge` px, as WebP (PNG where the browser can't write WebP). Null
// when no try makes one that `fits`.
function shrink(
	image: CanvasImageSource,
	source: Rect,
	{ tries, fits }: { tries: readonly Try[]; fits: (url: string) => boolean }
): string | null {
	for (const { edge, quality } of tries) {
		const scale = Math.min(1, edge / Math.max(source.width, source.height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(source.width * scale));
		canvas.height = Math.max(1, Math.round(source.height * scale));
		const context = canvas.getContext("2d");
		if (!context) return null;
		context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
		let url = canvas.toDataURL("image/webp", quality);
		if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/png");
		if (fits(url)) return url;
	}
	return null;
}

// A sticker small enough to keep on the group's row, the whole picture at most 256px across. Null when it isn't a
// picture this browser can read, or can't be made small enough.
export async function stickerFromFile(file: File): Promise<string | null> {
	if (!file.type.startsWith("image/")) return null;
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return null;
	}
	try {
		const whole = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
		return shrink(bitmap, whole, {
			tries: STICKER_TRIES,
			fits: (url) => url.length <= STICKER_LIMIT && isSticker(url),
		});
	} finally {
		bitmap.close();
	}
}

// A picture, loaded and ready to draw: a file someone chose (by an object URL) or a photo already kept. Null when
// this browser can't read it. Waits for load rather than decode(), which can wait until the page is drawn.
export function loadImage(src: string): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve(image.naturalWidth > 0 ? image : null);
		image.onerror = () => resolve(null);
		image.src = src;
	});
}

// A profile photo: the chosen square of the picture, at most 192px.
export const photoFromSquare = (image: CanvasImageSource, square: Square) =>
	shrink(
		image,
		{ x: square.x, y: square.y, width: square.side, height: square.side },
		{
			tries: PROFILE_TRIES,
			fits: isPhoto,
		}
	);
