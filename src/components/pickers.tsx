import { Face } from "@/components/art/face";
import { HandDisc, type HandKind } from "@/components/art/hand";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export type PersonOption = { id: string; label: string };

// Pick one person (Paid by): chips with faces; the picked one is inked in.
export function PersonPicker({
	people,
	value,
	onChange,
	label,
}: {
	people: PersonOption[];
	value: string;
	onChange: (id: string) => void;
	label: string;
}) {
	return (
		<ToggleGroup
			type="single"
			aria-label={label}
			value={value}
			onValueChange={(next) => {
				if (next) onChange(next);
			}}
		>
			{people.map((p) => (
				<ToggleGroupItem key={p.id} value={p.id} look="single">
					<Face seed={p.id} name="" size={28} />
					{p.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}

// Pick several people (Split between): picked chips are cobalt, the rest dashed and faded.
export function PeoplePicker({
	people,
	value,
	onChange,
	label,
}: {
	people: PersonOption[];
	value: string[];
	onChange: (ids: string[]) => void;
	label: string;
}) {
	return (
		<ToggleGroup type="multiple" aria-label={label} value={value} onValueChange={onChange}>
			{people.map((p) => (
				<ToggleGroupItem key={p.id} value={p.id} look="multiple">
					<Face seed={p.id} name="" size={28} />
					{p.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}

export type CategoryOption<T extends string> = { value: T; label: string; kind: HandKind };

// The category row: a hand disc per category; tapping the picked one again clears it.
export function CategoryPicker<T extends string>({
	options,
	value,
	onChange,
	label,
	className,
}: {
	options: CategoryOption<T>[];
	value: T | null;
	onChange: (value: T | null) => void;
	label: string;
	className?: string;
}) {
	return (
		<ToggleGroup
			type="single"
			aria-label={label}
			value={value ?? ""}
			onValueChange={(next) => onChange(next ? (next as T) : null)}
			className={cn("grid grid-cols-6 gap-1 sm:gap-control", className)}
		>
			{options.map((o) => (
				<ToggleGroupItem
					key={o.value}
					value={o.value}
					look="plain"
					className="type-micro group h-auto flex-col gap-1.5 font-normal data-[state=on]:font-bold"
				>
					<HandDisc kind={o.kind} size={48} className="transition-shadow group-data-[state=on]:shadow-selected" />
					{o.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}
