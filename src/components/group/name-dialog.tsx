import { useEffect, useState } from "react";

import { EditorDialog } from "@/components/editor-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type NameDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	submitLabel: string;
	initial?: string;
	// Whether the name already belongs to someone in the group, checked as it is typed.
	taken?: (name: string) => boolean;
	// Resolves true when saved, so the dialog closes.
	onSave: (name: string) => Promise<boolean>;
};

// One name to type: Add person, Rename.
export function NameDialog({ open, onOpenChange, title, submitLabel, initial = "", taken, onSave }: NameDialogProps) {
	const [name, setName] = useState(initial);
	const clash = name.trim().length > 0 && !!taken?.(name);
	useEffect(() => {
		if (open) setName(initial);
	}, [open, initial]);

	return (
		<EditorDialog
			open={open}
			onOpenChange={onOpenChange}
			title={title}
			submitLabel={submitLabel}
			canSubmit={name.trim().length > 0 && name.trim() !== initial.trim() && !clash}
			onSubmit={async () => {
				if (await onSave(name.trim())) onOpenChange(false);
			}}
		>
			<Field label="Name" htmlFor="person-name" error={clash ? `${name.trim()} is already in this group` : undefined}>
				<Input id="person-name" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
			</Field>
		</EditorDialog>
	);
}
