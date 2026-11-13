import { isSticker, STICKER_LIMIT } from "@/lib/cover-stickers";

// Each try draws the picture smaller and plainer, until it fits in a sticker.
const TRIES = [
	{ edge: 256, quality: 0.85 },
	{ edge: 192, quality: 0.75 },
	{ edge: 128, quality: 0.7 },
] as const;

// A picture someone chose, made small enough to keep on the group's row: drawn into a square of at most 256px, as
// WebP (PNG where the browser can't write WebP). Null when it isn't a picture this browser can read, or can't be
// made small enough.
export async function stickerFromFile(file: File): Promise<string | null> {
	if (!file.type.startsWith("image/")) return null;
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return null;
	}
	try {
		for (const { edge, quality } of TRIES) {
			const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const context = canvas.getContext("2d");
			if (!context) return null;
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			let url = canvas.toDataURL("image/webp", quality);
			if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/png");
			if (url.length <= STICKER_LIMIT && isSticker(url)) return url;
		}
		return null;
	} finally {
		bitmap.close();
	}
}
