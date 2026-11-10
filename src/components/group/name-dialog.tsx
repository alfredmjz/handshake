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
	// Resolves true when saved, so the dialog closes.
	onSave: (name: string) => Promise<boolean>;
};

// One name to type: Add person, Rename.
export function NameDialog({ open, onOpenChange, title, submitLabel, initial = "", onSave }: NameDialogProps) {
	const [name, setName] = useState(initial);
	useEffect(() => {
		if (open) setName(initial);
	}, [open, initial]);

	return (
		<EditorDialog
			open={open}
			onOpenChange={onOpenChange}
			title={title}
			submitLabel={submitLabel}
			canSubmit={name.trim().length > 0 && name.trim() !== initial.trim()}
			onSubmit={async () => {
				if (await onSave(name.trim())) onOpenChange(false);
			}}
		>
			<Field label="Name" htmlFor="person-name">
				<Input id="person-name" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
			</Field>
		</EditorDialog>
	);
}
