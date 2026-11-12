import type { CSSProperties } from "react";

import { Hand, type HandKind } from "@/components/art/hand";
import { CoverSticker } from "@/components/cover-sticker";
import { coverHsl, coverIsDeep, type CoverKey } from "@/lib/cover-colors";
import { cn } from "@/lib/utils";

// A group is a notebook. Its cover takes the group's own colour from the colour board, its sticker (or the hand of
// what the group is mostly for), a spine on the left and pages showing behind.
function PagesBehind() {
	return <div aria-hidden className="absolute inset-[4px_-4px_-4px_4px] rounded-book border border-ink/20 bg-paper" />;
}

function Spine() {
	return <span aria-hidden className="absolute inset-y-0 left-0 w-3 bg-ink/15" />;
}

type BookCoverProps = {
	name: string;
	// The group's note, a second line under the name.
	note?: string | null;
	kind: HandKind;
	// The group's sticker; null shows the hand of its kind.
	sticker?: string | null;
	cover: CoverKey;
	className?: string;
};

// The small cover in the Groups grid. Deep colours take paper-coloured type.
export function BookCover({ name, note, kind, sticker, cover, className }: BookCoverProps) {
	return (
		<div className={cn("relative aspect-[5/6] w-full", className)}>
			<PagesBehind />
			<div
				className="absolute inset-0 overflow-hidden rounded-book bg-[hsl(var(--cover))] transition-colors duration-settle ease-out [container-type:inline-size]"
				style={{ "--cover": coverHsl(cover) } as CSSProperties}
			>
				<Spine />
				<CoverSticker
					sticker={sticker}
					fallback={kind}
					size="54cqi"
					className="absolute left-1/2 top-[5cqi] -translate-x-1/2"
				/>
				<span
					className={cn(
						"absolute inset-x-[1.375rem] bottom-3.5 flex flex-col gap-0.5 pr-0.5",
						coverIsDeep(cover) ? "text-paper" : "text-ink"
					)}
				>
					<span className="type-cover line-clamp-2 break-words">{name}</span>
					{note && <span className="type-label line-clamp-1 break-words font-display">{note}</span>}
				</span>
			</div>
		</div>
	);
}

// The dashed empty cover that starts a new group.
export function NewBookButton({
	label,
	onClick,
	className,
}: {
	label: string;
	onClick: () => void;
	className?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"type-hand flex aspect-[5/6] w-full flex-col items-center justify-center gap-1 rounded-book border-2 border-dashed border-ink/35 bg-paper/60 transition-colors hover:border-ink/60 hover:bg-raised",
				className
			)}
		>
			<Hand kind="new" size={96} />
			{label}
		</button>
	);
}
