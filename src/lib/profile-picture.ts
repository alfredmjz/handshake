// A person's picture: one per account, shown in place of their drawn face in every group they're in. A small square
// made on their device (src/lib/picture-file.ts) and kept as a data URL; null is the drawn face.
// private.profile_picture() refuses what isProfilePicture refuses.

// The longest picture kept, in characters: room for a small square, not a photo at full size.
export const PICTURE_LIMIT = 40_000;
const PICTURE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isProfilePicture(value: unknown): value is string {
	return typeof value === "string" && value.length <= PICTURE_LIMIT && PICTURE.test(value);
}
