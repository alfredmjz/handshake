import type { FormEvent, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type EditorDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	submitLabel: string;
	canSubmit: boolean;
	onSubmit: () => void | Promise<void>;
	// Extra controls beside the save button (Delete).
	secondary?: ReactNode;
	children: ReactNode;
};

// An editor: the whole screen on phones, a dialog from 640px. A form, so Enter saves; the main button
// sits at the bottom and stays off until the form is complete.
export function EditorDialog({
	open,
	onOpenChange,
	title,
	description,
	submitLabel,
	canSubmit,
	onSubmit,
	secondary,
	children,
}: EditorDialogProps) {
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (canSubmit) void onSubmit();
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="screen">
				<form onSubmit={submit} className="flex min-h-full flex-1 flex-col gap-section">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						{description ? (
							<DialogDescription>{description}</DialogDescription>
						) : (
							<DialogDescription className="sr-only">{title}</DialogDescription>
						)}
					</DialogHeader>
					<div className="flex flex-1 flex-col gap-section">{children}</div>
					<div className="sticky bottom-0 -mx-page mt-auto flex flex-col gap-control bg-background px-page pt-control sm:static sm:mx-0 sm:flex-row-reverse sm:px-0">
						<Button type="submit" size="lg" disabled={!canSubmit} className="w-full sm:w-auto">
							{submitLabel}
						</Button>
						{secondary}
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
