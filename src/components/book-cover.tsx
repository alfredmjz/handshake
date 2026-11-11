import { useState, type CSSProperties, type ReactNode } from "react";

import { Hand, type HandKind } from "@/components/art/hand";
import { cn } from "@/lib/utils";

// A group is a notebook. Its cover takes the colour and hand of what the group is mostly for, with a
// spine on the left and pages showing behind.
const COVER_TINT: Record<HandKind, string> = {
	food: "bg-category-food",
	drinks: "bg-category-drinks",
	stay: "bg-category-stay",
	travel: "bg-category-travel",
	groceries: "bg-category-groceries",
	fun: "bg-category-fun",
	new: "bg-category-none",
	shake: "bg-category-none",
};

function PagesBehind() {
	return <div aria-hidden className="absolute inset-[4px_-4px_-4px_4px] rounded-book border border-ink/20 bg-paper" />;
}

function Spine({ wide = false }: { wide?: boolean }) {
	return <span aria-hidden className={cn("absolute inset-y-0 left-0 bg-ink/15", wide ? "w-3.5" : "w-3")} />;
}

type BookCoverProps = {
	name: string;
	// The group's note, a second line under the name.
	note?: string | null;
	kind: HandKind;
	className?: string;
	style?: CSSProperties;
};

// The small cover in the Groups grid.
export function BookCover({ name, note, kind, className, style }: BookCoverProps) {
	return (
		<div className={cn("relative aspect-[5/6] w-full", className)} style={style}>
			<PagesBehind />
			<div className={cn("absolute inset-0 overflow-hidden rounded-book", COVER_TINT[kind])}>
				<Spine />
				<div className="absolute left-1/2 top-1.5 size-[6.25rem] -translate-x-1/2 overflow-hidden">
					<Hand kind={kind} size={100} />
				</div>
				<span className="absolute inset-x-[1.375rem] bottom-3.5 flex flex-col gap-0.5 pr-0.5 text-ink">
					<span className="type-cover line-clamp-2 break-words">{name}</span>
					{note && <span className="type-label line-clamp-1 break-words font-display">{note}</span>}
				</span>
			</div>
		</div>
	);
}

function CoverFace({ name, note, kind }: { name: string; note: string | null; kind: HandKind }) {
	return (
		<>
			<Spine wide />
			<span className="absolute right-panel top-1/2 size-24 -translate-y-1/2 overflow-hidden">
				<Hand kind={kind} size={96} />
			</span>
			<span className="absolute inset-y-0 left-8 right-32 flex flex-col justify-center gap-0.5 text-left text-ink">
				<span className="type-h3 line-clamp-2 break-words">{name}</span>
				{note && <span className="type-label line-clamp-1 break-words font-display">{note}</span>}
			</span>
		</>
	);
}

type BookProps = {
	name: string;
	note: string | null;
	kind: HandKind;
	// The ledger page, always open: what you came for is never behind a tap.
	children: ReactNode;
	// Arriving from the shelf: the cover swings open once on its spine to show the page.
	opening?: boolean;
	className?: string;
	style?: CSSProperties;
};

// The group's notebook on its own page. The spine keeps the cover's colour; the ruled margin is the page's.
export function Book({ name, note, kind, children, opening = false, className, style }: BookProps) {
	const [covered, setCovered] = useState(opening);

	return (
		<div className={cn("book-stage relative", className)} style={style}>
			<PagesBehind />
			<div className="relative overflow-hidden rounded-book border border-ink/15 bg-raised py-panel pl-[calc(var(--space-panel)+1.25rem)] pr-panel">
				<span aria-hidden className={cn("absolute inset-y-0 left-0 w-2.5", COVER_TINT[kind])} />
				<span aria-hidden className="absolute inset-y-0 left-[1.125rem] border-l-[1.5px] border-owe-mark/30" />
				{children}
			</div>
			{covered && (
				<div
					aria-hidden
					className={cn(
						"book-cover-opening pointer-events-none absolute inset-0 animate-cover-open overflow-hidden rounded-book",
						COVER_TINT[kind]
					)}
					onAnimationEnd={(e) => {
						if (e.animationName === "cover-open") setCovered(false);
					}}
				>
					<span className="contents [&>*]:animate-cover-face-hide">
						<CoverFace name={name} note={note} kind={kind} />
					</span>
				</div>
			)}
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
				"type-body-sm flex aspect-[5/6] w-full flex-col items-center justify-center gap-1 rounded-book border-2 border-dashed border-ink/35 font-semibold transition-colors hover:border-ink/60 hover:bg-ink/[0.03]",
				className
			)}
		>
			<Hand kind="new" size={96} />
			{label}
		</button>
	);
}
