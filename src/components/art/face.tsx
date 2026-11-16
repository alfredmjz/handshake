import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from "react";

import { FACE_PATHS } from "@/components/art/art-markup";
import { assignSlots, lookOf, slotOf, tintOf } from "@/lib/face-slots";
import { chosenSlot, parseProfilePicture } from "@/lib/profile-picture";
import { cn } from "@/lib/utils";

const LOOKS = ["alex", "jo", "priya", "sam", "mo"] as const;
// The disc colours, in slot order: a face's colour, and the backgrounds a photo can sit on.
export const FACE_TINTS = ["drinks", "groceries", "fun", "travel", "stay", "food"] as const;
const TINTS = FACE_TINTS;

// A group's people: each one's slot, and the photos of those who have one, by member id.
type Faces = { slots: Map<string, number>; photos: Map<string, string> };

const FacesContext = createContext<Faces | null>(null);

// Inside a group, faces are dealt so no two members look alike (see assignSlots), people who chose a face have it,
// and people with a photo show it.
export function FaceSlots({
	members,
	children,
}: {
	members: { id: string; userId: string | null; picture?: string | null }[] | undefined;
	children: ReactNode;
}) {
	const faces = useMemo(
		() =>
			members
				? {
						slots: assignSlots(members.map((m) => ({ ...m, chosen: chosenSlot(m.picture) }))),
						photos: new Map(
							members.flatMap((m) => {
								const picture = parseProfilePicture(m.picture);
								return picture?.kind === "photo" ? [[m.id, picture.src] as const] : [];
							})
						),
					}
				: null,
		[members]
	);
	return <FacesContext.Provider value={faces}>{children}</FacesContext.Provider>;
}

const lookAt = (slot: number) => ({ look: LOOKS[lookOf(slot)], tint: TINTS[tintOf(slot) % TINTS.length] });

// The same person always gets the same drawing and disc colour: from their slot in the group, else from the seed.
function useLook(seed: string) {
	return lookAt(useContext(FacesContext)?.slots.get(seed) ?? slotOf(seed));
}

// The disc colour of a person's face as drawn here: their slot inside a group's FaceSlots, else the seed's.
export function useFaceTint(seed: string) {
	return `hsl(var(--category-${useLook(seed).tint}))`;
}

function faceMarkup(look: (typeof LOOKS)[number]) {
	return FACE_PATHS.filter((p) => (p.who === null || p.who === look) && !(p.mouth && look === "sam"))
		.map((p) => p.svg)
		.join("");
}

// The drawing's head is centred at (24, 25) with the shoulders below. Enlarged and moved so the person sits in
// the middle of the disc, like a portrait, with the shoulders running off the bottom edge.
const FACE_SCALE = 1.3;
const FACE_FIT = `translate(24 24) scale(${FACE_SCALE}) translate(-24 -27)`;

type FaceProps = {
	seed: string;
	name: string;
	size: number;
	className?: string;
	// Faded, for someone who left or isn't picked.
	faded?: boolean;
	// Their picture where FaceSlots doesn't know them (the account menu, Settings): a chosen face or a photo, or
	// null for the default drawing.
	picture?: string | null;
};

// A one-line portrait on a colour disc, or the person's own picture. The colour only tells people apart; it never
// means money.
export function Face({ seed, name, size, className, faded = false, picture }: FaceProps) {
	const dealt = useLook(seed);
	const known = useContext(FacesContext)?.photos.get(seed) ?? null;
	const given = picture === undefined ? null : parseProfilePicture(picture);
	const src = picture === undefined ? known : given?.kind === "photo" ? given.src : null;
	const { look, tint } = given?.kind === "face" ? lookAt(given.slot) : dealt;
	const markup = useMemo(() => faceMarkup(look), [look]);
	const style = {
		width: size,
		height: size,
		background: `hsl(var(--category-${tint}))`,
		"--face-dot": (size < 40 ? 3.4 : 2.8) / FACE_SCALE,
	} as CSSProperties;

	return (
		<span
			data-chip-art
			className={cn("inline-flex shrink-0 overflow-hidden rounded-full", faded && "opacity-45", className)}
			style={style}
		>
			{src ? (
				<img src={src} alt={name} draggable={false} className="block size-full object-cover" />
			) : (
				<svg
					viewBox="0 0 48 48"
					// Buttons size every svg inside them as an icon; a face always fills its own disc.
					className="block size-full!"
					{...(name ? { role: "img", "aria-label": name } : { "aria-hidden": true })}
				>
					<g
						className="doodle"
						transform={FACE_FIT}
						style={{ strokeWidth: (size < 40 ? 2.2 : size < 64 ? 1.8 : 1.5) / FACE_SCALE }}
						dangerouslySetInnerHTML={{ __html: markup }}
					/>
				</svg>
			)}
		</span>
	);
}

// Overlapping faces for a group's people, with a ring of paper between them.
export function FacePile({
	people,
	size,
	max = 5,
	className,
}: {
	people: { id: string; name: string }[];
	size: number;
	max?: number;
	className?: string;
}) {
	const shown = people.slice(0, max);
	const extra = people.length - shown.length;
	return (
		<span className={cn("flex items-center", className)}>
			{shown.map((p, i) => (
				<span key={p.id} className="rounded-full ring-2 ring-paper" style={{ marginLeft: i === 0 ? 0 : -size * 0.27 }}>
					<Face seed={p.id} name={p.name} size={size} />
				</span>
			))}
			{extra > 0 && (
				<span
					className="type-caption inline-flex items-center justify-center rounded-full bg-sunken font-semibold ring-2 ring-paper"
					style={{ width: size, height: size, marginLeft: -size * 0.27 }}
				>
					+{extra}
				</span>
			)}
		</span>
	);
}
