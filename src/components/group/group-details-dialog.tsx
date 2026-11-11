import { useEffect, useState } from "react";

import { EditorDialog } from "@/components/editor-dialog";
import { useRun } from "@/components/group/use-run";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { GroupRow } from "@/lib/sync/types";

// The group's name and the note on its cover.
export function GroupDetailsDialog({
	group,
	open,
	onOpenChange,
}: {
	group: GroupRow;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const run = useRun();
	const [name, setName] = useState(group.name);
	const [note, setNote] = useState(group.note ?? "");
	useEffect(() => {
		if (open) {
			setName(group.name);
			setNote(group.note ?? "");
		}
	}, [open, group.name, group.note]);

	const nameChanged = name.trim() !== group.name;
	const noteChanged = note.trim() !== (group.note ?? "");

	return (
		<EditorDialog
			open={open}
			onOpenChange={onOpenChange}
			title="Name and note"
			submitLabel="Save"
			canSubmit={name.trim().length > 0 && (nameChanged || noteChanged)}
			onSubmit={async () => {
				if (nameChanged) {
					const plan = await run({ type: "renameGroup", groupId: group.id, name: name.trim() });
					if (!plan.ok) return;
				}
				if (noteChanged) {
					const plan = await run({ type: "describeGroup", groupId: group.id, note: note.trim() || null });
					if (!plan.ok) return;
				}
				onOpenChange(false);
			}}
		>
			<Field label="Name" htmlFor="group-name">
				<Input id="group-name" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
			</Field>
			<Field label="Note" htmlFor="group-note" hint="On the cover, under the name.">
				<Input
					id="group-note"
					maxLength={120}
					placeholder="Tokyo and Kyoto, April"
					value={note}
					onChange={(e) => setNote(e.target.value)}
				/>
			</Field>
		</EditorDialog>
	);
}
