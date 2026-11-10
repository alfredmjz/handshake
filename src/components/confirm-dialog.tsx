import type { ReactNode } from "react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type ConfirmDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	// What will happen and to whom; one or two short lines.
	description?: ReactNode;
	confirmLabel: string;
	cancelLabel?: string;
	tone?: "default" | "destructive";
	onConfirm: () => void | Promise<void>;
	children?: ReactNode;
};

// "Delete Dinner?", "Complete Japan 2027?": one question, the action named on its button.
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	cancelLabel = "Cancel",
	tone = "default",
	onConfirm,
	children,
}: ConfirmDialogProps) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					{description && (
						<AlertDialogDescription asChild>
							<div className="flex flex-col gap-control">{description}</div>
						</AlertDialogDescription>
					)}
				</AlertDialogHeader>
				{children}
				<AlertDialogFooter>
					<AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
					<AlertDialogAction tone={tone} onClick={() => void onConfirm()}>
						{confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
