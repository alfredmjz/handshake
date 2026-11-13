import { useState } from "react";

import { useRun } from "@/components/group/use-run";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { billItems } from "@/lib/settle-view";
import type { EntryRow } from "@/lib/sync/types";
import { cn } from "@/lib/utils";

const MAX = 1000;

// A bill's note, written in the margin. Whoever may edit the bill can add or change it right here.
export function EntryNote({ entry, mayEdit }: { entry: EntryRow; mayEdit: boolean }) {
	const run = useRun();
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(entry.notes ?? "");
	const [saving, setSaving] = useState(false);

	if (!entry.notes && !mayEdit) return null;

	const open = () => {
		setText(entry.notes ?? "");
		setEditing(true);
	};

	const save = async () => {
		setSaving(true);
		const plan = await run({
			type: "editExpense",
			groupId: entry.groupId,
			entryId: entry.id,
			draft: {
				description: entry.description,
				entryDate: entry.entryDate,
				notes: text.trim() ? text : null,
				category: entry.category,
				items: billItems(entry),
			},
		});
		setSaving(false);
		if (plan.ok) setEditing(false);
	};

	if (editing) {
		return (
			<section className="flex flex-col gap-control">
				<label htmlFor="entry-note" className="type-hand">
					Note
				</label>
				<Textarea
					id="entry-note"
					autoFocus
					rows={3}
					maxLength={MAX}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") setEditing(false);
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
					}}
				/>
				<div className="flex gap-control">
					<Button size="sm" onClick={() => void save()} disabled={saving || text === (entry.notes ?? "")}>
						{saving ? "Saving…" : "Save note"}
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
						Cancel
					</Button>
				</div>
			</section>
		);
	}

	if (!entry.notes) {
		return (
			<Button variant="link" size="inline" className="type-hand self-start" onClick={open}>
				+ Add a note
			</Button>
		);
	}

	const note = <p className="type-hand-lg whitespace-pre-wrap break-words text-left">{entry.notes}</p>;
	return mayEdit ? (
		<button
			type="button"
			onClick={open}
			aria-label="Edit note"
			className={cn(
				"group -mx-2 flex flex-col gap-1 rounded-lg px-2 py-1 text-left transition-colors duration-quick ease-out hover:bg-ink/[0.04]"
			)}
		>
			{note}
			<span className="type-caption text-muted-foreground opacity-0 transition-opacity duration-quick group-hover:opacity-100 group-focus-visible:opacity-100">
				Tap to edit
			</span>
		</button>
	) : (
		note
	);
}
