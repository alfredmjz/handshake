import { useRef, useState, type KeyboardEvent } from "react";
import { ImagePlus } from "lucide-react";
import { toast } from "sonner";

import type { HandKind } from "@/components/art/hand";
import { CoverSticker } from "@/components/cover-sticker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	COMMON_STICKERS,
	emojiSticker,
	handSticker,
	HANDS,
	isEmoji,
	parseSticker,
	suggestStickers,
} from "@/lib/cover-stickers";
import { stickerFromFile } from "@/lib/sticker-image";
import { cn } from "@/lib/utils";

type StickerPickerProps = {
	// The chosen sticker, or null for the default.
	value: string | null;
	onChange: (value: string | null) => void;
	// The group's name, for stickers it brings to mind.
	name: string;
	// The hand shown by default.
	fallback: HandKind;
	className?: string;
};

const HAND_LABELS: Record<(typeof HANDS)[number], string> = {
	food: "Food hand",
	drinks: "Drinks hand",
	stay: "Stay hand",
	travel: "Travel hand",
	groceries: "Groceries hand",
	fun: "Fun hand",
	new: "Writing hand",
};

// Pick what goes on the cover: the default hand, an emoji the name brings to mind, one of the hands, a few common
// emoji, any emoji typed in, or a picture of your own. Arrow keys walk the choices.
export function StickerPicker({ value, onChange, name, fallback, className }: StickerPickerProps) {
	const [typed, setTyped] = useState("");
	const [reading, setReading] = useState(false);
	const file = useRef<HTMLInputElement>(null);
	const board = useRef<HTMLDivElement>(null);

	const suggested = suggestStickers(name);
	const emoji = [...suggested, ...COMMON_STICKERS.filter((e) => !suggested.includes(e))].map(emojiSticker);
	const choices: (string | null)[] = [null, ...emoji.slice(0, suggested.length), ...HANDS.map(handSticker)];
	choices.push(...emoji.slice(suggested.length));
	// A sticker of their own (a typed emoji, a picture) stays on the board while it's the one chosen.
	if (value !== null && !choices.includes(value)) choices.splice(1, 0, value);

	const labelOf = (choice: string | null) => {
		if (choice === null) return "Default";
		const sticker = parseSticker(choice);
		if (sticker?.kind === "hand") return HAND_LABELS[sticker.hand];
		if (sticker?.kind === "emoji") return sticker.emoji;
		return "Your picture";
	};

	const move = (event: KeyboardEvent) => {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (!step) return;
		event.preventDefault();
		const next = choices[(choices.indexOf(value) + step + choices.length) % choices.length];
		onChange(next);
		board.current?.querySelector<HTMLButtonElement>(`[data-choice="${choices.indexOf(next)}"]`)?.focus();
	};

	const upload = async (picked: File | undefined) => {
		if (!picked) return;
		setReading(true);
		const sticker = await stickerFromFile(picked);
		setReading(false);
		if (sticker) onChange(sticker);
		else toast.error("That picture can't be used. Try a PNG, JPEG or WebP.");
	};

	return (
		<div className={cn("flex flex-col gap-control", className)}>
			<div
				ref={board}
				role="radiogroup"
				aria-label="Sticker"
				onKeyDown={move}
				className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1.5"
			>
				{choices.map((choice, i) => {
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
							tabIndex={on ? 0 : -1}
							onClick={() => onChange(choice)}
							className={cn(
								"flex aspect-square items-center justify-center rounded-md border border-border bg-paper outline-none transition-transform duration-quick ease-out hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring",
								on && "border-ink ring-2 ring-ink ring-offset-1 ring-offset-paper"
							)}
						>
							<CoverSticker sticker={choice} fallback={fallback} size="2.25rem" />
						</button>
					);
				})}
			</div>
			<div className="flex flex-wrap items-center gap-control">
				<Input
					aria-label="Any emoji"
					placeholder="Any emoji"
					maxLength={16}
					value={typed}
					onChange={(event) => {
						const next = event.target.value.trim();
						setTyped(event.target.value);
						if (isEmoji(next)) onChange(emojiSticker(next));
					}}
					className="w-32"
				/>
				<Button type="button" size="sm" variant="secondary" disabled={reading} onClick={() => file.current?.click()}>
					<ImagePlus />
					{reading ? "Reading…" : "Upload a picture"}
				</Button>
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
			{typed.trim() !== "" && !isEmoji(typed.trim()) && (
				<p className="type-caption text-muted-foreground">One emoji, like 🏖️</p>
			)}
		</div>
	);
}
