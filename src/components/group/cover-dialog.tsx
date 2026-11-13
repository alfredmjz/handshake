import { useEffect, useState } from "react";

import { BookCover } from "@/components/book-cover";
import { ColorBoard } from "@/components/color-board";
import { EditorDialog } from "@/components/editor-dialog";
import type { GroupData } from "@/components/group/group-data";
import { useRun } from "@/components/group/use-run";
import { StickerPicker } from "@/components/sticker-picker";
import { coverOf, isCoverKey, type CoverKey } from "@/lib/cover-colors";
import { isSticker } from "@/lib/cover-stickers";

// The cover: its sticker and its colour, with the book beside them. Everyone in the group sees the change.
export function CoverDialog({
	data,
	open,
	onOpenChange,
}: {
	data: GroupData;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const run = useRun();
	const group = data.group!;
	const storedColor = isCoverKey(group.coverColor) ? group.coverColor : null;
	const storedSticker = isSticker(group.coverSticker) ? group.coverSticker : null;
	const [color, setColor] = useState<CoverKey | null>(storedColor);
	const [sticker, setSticker] = useState<string | null>(storedSticker);
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		if (!open) return;
		setColor(storedColor);
		setSticker(storedSticker);
	}, [open, storedColor, storedSticker]);

	const fallback = coverOf({ id: group.id, coverColor: null });
	const kind = data.category ?? "new";
	const mayColor = data.can("group.recolor");
	const maySticker = data.can("group.sticker");

	return (
		<EditorDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Cover"
			submitLabel={saving ? "Saving…" : "Save cover"}
			canSubmit={(color !== storedColor || sticker !== storedSticker) && !saving}
			onSubmit={async () => {
				setSaving(true);
				let ok = true;
				if (sticker !== storedSticker) ok = (await run({ type: "stickGroup", groupId: group.id, sticker })).ok;
				if (ok && color !== storedColor) ok = (await run({ type: "recolorGroup", groupId: group.id, color })).ok;
				setSaving(false);
				if (ok) onOpenChange(false);
			}}
		>
			<div className="flex flex-col items-center gap-section sm:flex-row sm:items-start">
				<BookCover
					name={group.name}
					note={group.note}
					kind={kind}
					sticker={sticker}
					cover={color ?? fallback}
					className="w-36 shrink-0"
				/>
				<div className="flex w-full min-w-0 flex-col gap-section">
					{maySticker && (
						<fieldset className="flex flex-col gap-control">
							<legend className="type-label mb-control font-medium">Sticker</legend>
							<StickerPicker value={sticker} onChange={setSticker} name={group.name} fallback={kind} />
						</fieldset>
					)}
					{mayColor && (
						<fieldset className="flex flex-col gap-control">
							<legend className="type-label mb-control font-medium">Colour</legend>
							<ColorBoard value={color} fallback={fallback} onChange={setColor} />
						</fieldset>
					)}
				</div>
			</div>
		</EditorDialog>
	);
}
