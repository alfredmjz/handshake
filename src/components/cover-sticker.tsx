import type { CSSProperties } from "react";

import { Hand, type HandKind } from "@/components/art/hand";
import { parseSticker } from "@/lib/cover-stickers";
import { cn } from "@/lib/utils";

type CoverStickerProps = {
	// The group's sticker; anything that isn't one shows the fallback hand.
	sticker: string | null | undefined;
	// The hand of what the group is mostly for, the default.
	fallback: HandKind;
	// The box it fills, as a CSS length: px on a list, cqi on a cover so it grows with the book.
	size: string;
	className?: string;
};

// What sits on a group's cover. A hand is drawn straight onto it; an emoji or a picture is a die-cut sticker,
// stuck on a little crooked.
export function CoverSticker({ sticker, fallback, size, className }: CoverStickerProps) {
	const parsed = parseSticker(sticker);
	const box = { width: size, height: size, "--sticker-size": size } as CSSProperties;

	if (!parsed || parsed.kind === "hand") {
		return (
			<span className={cn("flex shrink-0 items-center justify-center", className)} style={box}>
				{/* Drawn at 100 so its lines keep their weight, then sized to the box. */}
				<Hand kind={parsed?.kind === "hand" ? parsed.hand : fallback} size={100} className="size-full" />
			</span>
		);
	}
	return (
		<span className={cn("flex shrink-0 items-center justify-center", className)} style={box}>
			{parsed.kind === "emoji" ? (
				<span className="sticker sticker-emoji">{parsed.emoji}</span>
			) : (
				<img src={parsed.src} alt="" draggable={false} className="sticker size-[78%] rounded-md object-contain" />
			)}
		</span>
	);
}
