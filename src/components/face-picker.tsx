import { useRef, useState, type KeyboardEvent } from "react";
import { ImagePlus } from "lucide-react";
import { toast } from "sonner";

import { Face } from "@/components/art/face";
import { Button } from "@/components/ui/button";
import { SLOTS } from "@/lib/face-slots";
import { pictureFromFile } from "@/lib/picture-file";
import { faceChoice, isPhoto, parseProfilePicture } from "@/lib/profile-picture";
import { cn } from "@/lib/utils";

type FacePickerProps = {
	// The chosen picture, or null for the default.
	value: string | null;
	onChange: (value: string | null) => void;
	// Whose default face to show.
	seed: string;
	className?: string;
};

const FACES = Array.from({ length: SLOTS }, (_, slot) => faceChoice(slot));

// Pick your picture: the default face, one of the 30 drawn faces (each drawing in each colour, a colour to a row),
// or a photo of your own. Arrow keys walk the choices.
export function FacePicker({ value, onChange, seed, className }: FacePickerProps) {
	const [reading, setReading] = useState(false);
	const file = useRef<HTMLInputElement>(null);
	const board = useRef<HTMLDivElement>(null);

	// A photo of their own stays on the board while it's the one chosen.
	const top: (string | null)[] = isPhoto(value) ? [null, value] : [null];
	const choices = [...top, ...FACES];

	const labelOf = (choice: string | null) => {
		const picture = parseProfilePicture(choice);
		if (!picture) return "Default face";
		return picture.kind === "photo" ? "Your photo" : `Drawn face ${picture.slot + 1}`;
	};

	const move = (event: KeyboardEvent) => {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (!step || !(event.target as HTMLElement).matches("[role=radio]")) return;
		event.preventDefault();
		const at = Math.max(0, choices.indexOf(value));
		const next = choices[(at + step + choices.length) % choices.length];
		onChange(next);
		board.current?.querySelector<HTMLButtonElement>(`[data-choice="${choices.indexOf(next)}"]`)?.focus();
	};

	const upload = async (picked: File | undefined) => {
		if (!picked) return;
		setReading(true);
		const photo = await pictureFromFile(picked);
		setReading(false);
		if (photo) onChange(photo);
		else toast.error("That picture can't be used. Try a PNG, JPEG or WebP.");
	};

	const tile = (choice: string | null) => {
		const i = choices.indexOf(choice);
		const on = choice === value;
		return (
			<button
				key={choice ?? "default"}
				type="button"
				role="radio"
				data-choice={i}
				aria-checked={on}
				aria-label={labelOf(choice)}
				title={labelOf(choice)}
				tabIndex={on || (i === 0 && !choices.includes(value)) ? 0 : -1}
				onClick={() => onChange(choice)}
				className={cn(
					"flex aspect-square items-center justify-center rounded-full outline-hidden transition-transform duration-quick ease-out hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring",
					on && "ring-2 ring-ink ring-offset-2 ring-offset-paper"
				)}
			>
				<Face seed={seed} name="" size={44} picture={choice} />
			</button>
		);
	};

	return (
		<div className={cn("flex flex-col gap-stack", className)}>
			<div ref={board} role="radiogroup" aria-label="Picture" onKeyDown={move} className="flex flex-col gap-stack">
				<div className="flex flex-wrap items-center gap-control">
					{top.map(tile)}
					<Button type="button" size="sm" variant="secondary" disabled={reading} onClick={() => file.current?.click()}>
						<ImagePlus />
						{reading ? "Reading…" : "Upload a photo"}
					</Button>
				</div>
				<div className="grid w-fit grid-cols-5 gap-control">{FACES.map(tile)}</div>
			</div>
			<input
				ref={file}
				type="file"
				accept="image/png,image/jpeg,image/webp,image/gif"
				className="sr-only"
				tabIndex={-1}
				aria-hidden
				onChange={(event) => {
					void upload(event.target.files?.[0]);
					event.target.value = "";
				}}
			/>
		</div>
	);
}
