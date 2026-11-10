import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from "react";

import { FACE_PATHS } from "@/components/art/art-markup";
import { slotOf, assignSlots } from "@/lib/face-slots";
import { cn } from "@/lib/utils";

const LOOKS = ["alex", "jo", "priya", "sam", "mo"] as const;
const TINTS = ["drinks", "groceries", "fun", "travel", "stay", "food"] as const;

const SlotsContext = createContext<Map<string, number> | null>(null);

// Inside a group, faces are dealt so no two members look alike (see assignSlots).
export function FaceSlots({
	members,
	children,
}: {
	members: { id: string; userId: string | null }[] | undefined;
	children: ReactNode;
}) {
	const slots = useMemo(() => (members ? assignSlots(members) : null), [members]);
	return <SlotsContext.Provider value={slots}>{children}</SlotsContext.Provider>;
}

// The same person always gets the same drawing and disc colour: from their slot in the group, else from the seed.
function useLook(seed: string) {
	const slot = useContext(SlotsContext)?.get(seed) ?? slotOf(seed);
	return { look: LOOKS[slot % LOOKS.length], tint: TINTS[Math.floor(slot / LOOKS.length) % TINTS.length] };
}

// The disc colour a seed hashes to, for things that should match a person's face outside a group.
export function faceTint(seed: string) {
	const slot = slotOf(seed);
	return `hsl(var(--category-${TINTS[Math.floor(slot / LOOKS.length) % TINTS.length]}))`;
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

type FaceProps = {
	seed: string;
	name: string;
	size: number;
	className?: string;
	// Faded, for someone who left or isn't picked.
	faded?: boolean;
};

// A one-line portrait on a colour disc. The colour only tells people apart; it never means money.
export function Face({ seed, name, size, className, faded = false }: FaceProps) {
	const { look, tint } = useLook(seed);
	const markup = useMemo(() => faceMarkup(look), [look]);
	const style = {
		width: size,
		height: size,
		background: `hsl(var(--category-${tint}))`,
		"--face-dot": size < 40 ? 3.4 : 2.8,
	} as CSSProperties;

	return (
		<span
			data-chip-art
			className={cn("inline-flex shrink-0 overflow-hidden rounded-full", faded && "opacity-45", className)}
			style={style}
		>
			<svg
				viewBox="0 0 48 48"
				className="block size-full"
				{...(name ? { role: "img", "aria-label": name } : { "aria-hidden": true })}
			>
				<g
					className="doodle"
					style={{ strokeWidth: size < 40 ? 2.2 : size < 64 ? 1.8 : 1.5 }}
					dangerouslySetInnerHTML={{ __html: markup }}
				/>
			</svg>
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
