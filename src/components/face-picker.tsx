import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ImagePlus } from "lucide-react";
import { toast } from "sonner";

import { Face, FACE_TINTS } from "@/components/art/face";
import { Button } from "@/components/ui/button";
import { SLOTS, slotOf, tintOf } from "@/lib/face-slots";
import {
	MAX_ZOOM,
	MIN_ZOOM,
	cropSquare,
	panCrop,
	placeInFrame,
	startCrop,
	zoomCrop,
	type Crop,
} from "@/lib/photo-crop";
import { loadImage, photoFromSquare } from "@/lib/picture-file";
import { chosenSlot, faceChoice, isPhoto } from "@/lib/profile-picture";
import { cn } from "@/lib/utils";

type FacePickerProps = {
	// The chosen picture, or null for the default.
	value: string | null;
	onChange: (value: string | null) => void;
	// Whose default face to show.
	seed: string;
	className?: string;
};

// A photo of their own: the picture it is cut from, where the cut is, the background colour (a FACE_TINTS index),
// and the photo they make.
type Photo = { src: string; image: HTMLImageElement; crop: Crop; tint: number; value: string };

const FRAME = 144;
const NUDGE = 8;
const SLOT_LIST = Array.from({ length: SLOTS }, (_, slot) => slot);

const TINT_NAMES: Record<(typeof FACE_TINTS)[number], string> = {
	drinks: "Yellow",
	groceries: "Green",
	fun: "Pink",
	travel: "Blue",
	stay: "Purple",
	food: "Orange",
};

const sizeOf = (image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight });
const tintVar = (tint: number) => `hsl(var(--category-${FACE_TINTS[tint]}))`;
// The colour as the canvas needs it: the theme's value, not a var().
const tintColour = (tint: number) =>
	`hsl(${getComputedStyle(document.documentElement).getPropertyValue(`--category-${FACE_TINTS[tint]}`).trim()})`;

const makePhoto = (photo: Omit<Photo, "value">) =>
	photoFromSquare(
		photo.image,
		sizeOf(photo.image),
		cropSquare(sizeOf(photo.image), photo.crop),
		tintColour(photo.tint)
	);

// A tile in the picker: a picture with room around it, so the ring marking the one picked stays inside the tile.
const tileClass = (on: boolean) =>
	cn(
		"flex items-center justify-center rounded-full p-1 outline-hidden transition-transform duration-quick ease-out hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring",
		on && "ring-2 ring-inset ring-ink"
	);

// The photo in the round frame: drag it (or use the arrow keys) to move it; the parent zooms.
function CropFrame({ photo, onMove, onDone }: { photo: Photo; onMove: (crop: Crop) => void; onDone: () => void }) {
	const last = useRef<{ x: number; y: number } | null>(null);
	const size = sizeOf(photo.image);
	const place = placeInFrame(size, photo.crop, FRAME);

	const down = (event: PointerEvent<HTMLDivElement>) => {
		event.currentTarget.setPointerCapture(event.pointerId);
		last.current = { x: event.clientX, y: event.clientY };
	};
	const move = (event: PointerEvent<HTMLDivElement>) => {
		if (!last.current) return;
		onMove(panCrop(size, photo.crop, event.clientX - last.current.x, event.clientY - last.current.y, FRAME));
		last.current = { x: event.clientX, y: event.clientY };
	};
	const up = () => {
		if (!last.current) return;
		last.current = null;
		onDone();
	};
	const nudge = (event: KeyboardEvent) => {
		const by = { ArrowLeft: [NUDGE, 0], ArrowRight: [-NUDGE, 0], ArrowUp: [0, NUDGE], ArrowDown: [0, -NUDGE] }[
			event.key
		];
		if (!by) return;
		event.preventDefault();
		onMove(panCrop(size, photo.crop, by[0], by[1], FRAME));
	};

	return (
		<div
			role="group"
			aria-label="Photo position: drag, or use the arrow keys"
			tabIndex={0}
			onPointerDown={down}
			onPointerMove={move}
			onPointerUp={up}
			onPointerCancel={up}
			onKeyUp={(event) => event.key.startsWith("Arrow") && onDone()}
			onKeyDown={nudge}
			className="relative shrink-0 cursor-grab touch-none overflow-hidden rounded-full outline-hidden select-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
			style={{ width: FRAME, height: FRAME, background: tintVar(photo.tint) }}
		>
			<img
				src={photo.src}
				alt=""
				draggable={false}
				className="pointer-events-none absolute max-w-none"
				style={{ width: place.width, height: place.height, left: place.left, top: place.top }}
			/>
		</div>
	);
}

// Pick your picture from the 30 drawn faces (each drawing in each colour, a colour to a row; your default face is
// the one picked until you choose), or a photo of your own, cut to the frame on one of the faces' colours. Arrow keys
// walk the faces.
export function FacePicker({ value, onChange, seed, className }: FacePickerProps) {
	const [photo, setPhoto] = useState<Photo | null>(null);
	const [adjusting, setAdjusting] = useState(false);
	const [reading, setReading] = useState(false);
	const file = useRef<HTMLInputElement>(null);
	const board = useRef<HTMLDivElement>(null);
	const objectUrl = useRef<string | undefined>(undefined);

	const home = slotOf(seed);
	const picked = isPhoto(value) ? null : (chosenSlot(value) ?? home);

	// A photo already kept can be moved in its frame too, from what was kept.
	useEffect(() => {
		if (!isPhoto(value)) return;
		const kept = value;
		void loadImage(kept).then((image) => {
			if (image)
				setPhoto((now) => now ?? { src: kept, image, crop: startCrop(sizeOf(image)), tint: tintOf(home), value: kept });
		});
		// Only the picture the dialog opened with.
	}, []);
	useEffect(() => () => void (objectUrl.current && URL.revokeObjectURL(objectUrl.current)), []);

	const choose = (slot: number) => {
		setAdjusting(false);
		onChange(slot === home ? null : faceChoice(slot));
	};

	const walk = (event: KeyboardEvent) => {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (!step || !(event.target as HTMLElement).matches("[role=radio]")) return;
		event.preventDefault();
		const next = ((picked ?? home) + step + SLOTS) % SLOTS;
		choose(next);
		board.current?.querySelector<HTMLButtonElement>(`[data-slot="${next}"]`)?.focus();
	};

	// The cut, made into the photo kept.
	const cut = (next: Photo) => {
		const made = makePhoto(next);
		if (!made) return;
		setPhoto({ ...next, value: made });
		onChange(made);
	};

	const upload = async (chosen: File | undefined) => {
		if (!chosen) return;
		setReading(true);
		const src = URL.createObjectURL(chosen);
		const image = chosen.type.startsWith("image/") ? await loadImage(src) : null;
		setReading(false);
		const start = image ? { src, image, crop: startCrop(sizeOf(image)), tint: tintOf(home) } : null;
		const made = start ? makePhoto(start) : null;
		if (!start || !made) {
			URL.revokeObjectURL(src);
			toast.error("That picture can't be used. Try a PNG, JPEG or WebP.");
			return;
		}
		if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
		objectUrl.current = src;
		setPhoto({ ...start, value: made });
		setAdjusting(true);
		onChange(made);
	};

	const adjust = () => {
		if (!photo) return;
		setAdjusting(true);
		if (value !== photo.value) onChange(photo.value);
	};

	const cropping = adjusting && photo && value === photo.value ? photo : null;

	return (
		<div className={cn("flex flex-col items-center gap-section", className)}>
			<div className="flex flex-col items-center gap-control">
				{cropping ? (
					<>
						<CropFrame
							photo={cropping}
							onMove={(crop) => setPhoto({ ...cropping, crop })}
							onDone={() => photo && cut(photo)}
						/>
						<input
							type="range"
							aria-label="Zoom"
							min={MIN_ZOOM}
							max={MAX_ZOOM}
							step={0.01}
							value={cropping.crop.zoom}
							onChange={(event) =>
								cut({ ...cropping, crop: zoomCrop(sizeOf(cropping.image), cropping.crop, Number(event.target.value)) })
							}
							className="w-40 accent-ink"
						/>
						<p className="type-caption text-muted-foreground">Drag to move</p>
						<div role="group" aria-label="Background" className="flex gap-control">
							{FACE_TINTS.map((name, tint) => (
								<button
									key={name}
									type="button"
									aria-label={`${TINT_NAMES[name]} background`}
									title={`${TINT_NAMES[name]} background`}
									aria-pressed={tint === cropping.tint}
									onClick={() => cut({ ...cropping, tint })}
									className={tileClass(tint === cropping.tint)}
								>
									<span className="block size-7 rounded-full" style={{ background: tintVar(tint) }} />
								</button>
							))}
						</div>
					</>
				) : (
					<Face seed={seed} name="Your picture" size={FRAME} picture={value} />
				)}
			</div>
			<div className="flex flex-col items-center gap-stack">
				<div className="flex items-center gap-control">
					{photo && (
						<button
							type="button"
							aria-label="Adjust your photo"
							title="Adjust your photo"
							onClick={adjust}
							className={tileClass(false)}
						>
							<Face seed={seed} name="" size={44} picture={photo.value} />
						</button>
					)}
					<Button type="button" size="sm" variant="secondary" disabled={reading} onClick={() => file.current?.click()}>
						<ImagePlus />
						{reading ? "Reading…" : "Upload a photo"}
					</Button>
				</div>
				<div
					ref={board}
					role="radiogroup"
					aria-label="Drawn faces"
					onKeyDown={walk}
					className="grid w-fit grid-cols-5 gap-x-stack gap-y-control"
				>
					{SLOT_LIST.map((slot) => {
						const on = slot === picked;
						const label = slot === home ? `Drawn face ${slot + 1} (your default)` : `Drawn face ${slot + 1}`;
						return (
							<button
								key={slot}
								type="button"
								role="radio"
								data-slot={slot}
								aria-checked={on}
								aria-label={label}
								title={label}
								tabIndex={on || (picked === null && slot === 0) ? 0 : -1}
								onClick={() => choose(slot)}
								className={tileClass(on)}
							>
								<Face seed={seed} name="" size={44} picture={faceChoice(slot)} />
							</button>
						);
					})}
				</div>
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
