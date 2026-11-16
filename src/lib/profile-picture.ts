import { SLOTS } from "@/lib/face-slots";

// A person's picture: one per account, shown in every group they're in. null is the default (the drawn face the
// group deals them). private.profile_picture() refuses what parseProfilePicture refuses.
//   "face:12"                     one of the drawn faces, by its slot (src/lib/face-slots.ts)
//   "data:image/webp;base64,…"    a photo of their own, made a small square on their device first

export type ProfilePicture = { kind: "face"; slot: number } | { kind: "photo"; src: string };

// The longest picture kept, in characters: room for a small square, not a photo at full size.
export const PICTURE_LIMIT = 40_000;
const PHOTO = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const FACE = /^face:(0|[1-9][0-9]?)$/;

export function parseProfilePicture(value: unknown): ProfilePicture | null {
	if (typeof value !== "string" || value.length > PICTURE_LIMIT) return null;
	const face = FACE.exec(value);
	if (face) {
		const slot = Number(face[1]);
		return slot < SLOTS ? { kind: "face", slot } : null;
	}
	return PHOTO.test(value) ? { kind: "photo", src: value } : null;
}

export const isProfilePicture = (value: unknown): value is string => parseProfilePicture(value) !== null;

export const faceChoice = (slot: number) => `face:${slot}`;

// The slot of a chosen drawn face, or null for a photo or the default.
export function chosenSlot(value: string | null | undefined): number | null {
	const picture = parseProfilePicture(value);
	return picture?.kind === "face" ? picture.slot : null;
}

export const isPhoto = (value: string | null | undefined) => parseProfilePicture(value)?.kind === "photo";
