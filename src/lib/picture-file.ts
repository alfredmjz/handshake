import { isSticker, STICKER_LIMIT } from "@/lib/cover-stickers";
import { isPhoto } from "@/lib/profile-picture";

type Try = { edge: number; quality: number };

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

// A picture someone chose, drawn into a square of at most `edge` px (cut to its middle square first when `square`),
// as WebP (PNG where the browser can't write WebP). Null when it isn't a picture this browser can read, or no try
// makes one that `fits`.
async function shrink(
	file: File,
	{ tries, fits, square }: { tries: readonly Try[]; fits: (url: string) => boolean; square: boolean }
): Promise<string | null> {
	if (!file.type.startsWith("image/")) return null;
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return null;
	}
	try {
		const side = Math.min(bitmap.width, bitmap.height);
		const source = square
			? { x: (bitmap.width - side) / 2, y: (bitmap.height - side) / 2, width: side, height: side }
			: { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
		for (const { edge, quality } of tries) {
			const scale = Math.min(1, edge / Math.max(source.width, source.height));
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(source.width * scale));
			canvas.height = Math.max(1, Math.round(source.height * scale));
			const context = canvas.getContext("2d");
			if (!context) return null;
			context.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
			let url = canvas.toDataURL("image/webp", quality);
			if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/png");
			if (fits(url)) return url;
		}
		return null;
	} finally {
		bitmap.close();
	}
}

// A sticker small enough to keep on the group's row, the whole picture at most 256px across.
export const stickerFromFile = (file: File) =>
	shrink(file, { tries: STICKER_TRIES, fits: (url) => url.length <= STICKER_LIMIT && isSticker(url), square: false });

// A profile picture: the middle square, at most 192px.
export const pictureFromFile = (file: File) => shrink(file, { tries: PROFILE_TRIES, fits: isPhoto, square: true });
