import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Overlay>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Overlay
		ref={ref}
		className={cn(
			"fixed inset-0 z-50 bg-ink/40 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
			className
		)}
		{...props}
	/>
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

// sheet: rises from the bottom on phones, a centred card from 640px.
// screen: takes the whole phone screen (editors), a wider centred card from 640px.
const dialogContentVariants = cva(
	"fixed z-50 flex flex-col gap-section overflow-y-auto bg-background text-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 sm:left-1/2 sm:top-1/2 sm:max-h-[min(90dvh,56rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:border-border sm:shadow-pop sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95",
	{
		variants: {
			size: {
				sheet:
					"inset-x-0 bottom-0 max-h-[92dvh] rounded-t-sheet px-page pb-[max(var(--space-page),env(safe-area-inset-bottom))] pt-section data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom sm:right-auto sm:bottom-auto sm:w-full sm:max-w-md sm:p-section sm:data-[state=closed]:slide-out-to-bottom-0 sm:data-[state=open]:slide-in-from-bottom-0",
				screen:
					"inset-0 px-page pb-[max(var(--space-page),env(safe-area-inset-bottom))] pt-[max(var(--space-section),env(safe-area-inset-top))] sm:bottom-auto sm:right-auto sm:w-full sm:max-w-xl sm:p-section",
			},
		},
		defaultVariants: { size: "sheet" },
	}
);

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> &
	VariantProps<typeof dialogContentVariants> & { hideClose?: boolean };

const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
	({ className, children, size, hideClose = false, ...props }, ref) => (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Content ref={ref} className={cn(dialogContentVariants({ size }), className)} {...props}>
				{children}
				{!hideClose && (
					<DialogPrimitive.Close className="absolute right-3 top-3 inline-flex size-tap items-center justify-center rounded-full text-ink transition-colors hover:bg-ink/5 sm:right-4 sm:top-4">
						<X className="size-5" aria-hidden />
						<span className="sr-only">Close</span>
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Content>
		</DialogPortal>
	)
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn("flex flex-col gap-1 pr-tap", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn("mt-auto flex flex-col-reverse gap-control sm:flex-row sm:justify-end", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Title>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Title ref={ref} className={cn("type-h3", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Description>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Description ref={ref} className={cn("type-body-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
	Dialog,
	DialogPortal,
	DialogOverlay,
	DialogTrigger,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
};
