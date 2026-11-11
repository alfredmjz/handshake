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

function Spine() {
	return <span aria-hidden className="absolute inset-y-0 left-0 w-3 bg-ink/15" />;
}

type BookCoverProps = {
	name: string;
	// The group's note, a second line under the name.
	note?: string | null;
	kind: HandKind;
	className?: string;
};

// The small cover in the Groups grid.
export function BookCover({ name, note, kind, className }: BookCoverProps) {
	return (
		<div className={cn("relative aspect-[5/6] w-full", className)}>
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
