import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const gap = { none: "gap-0", control: "gap-control", stack: "gap-stack", section: "gap-section" };

const stackVariants = cva("flex flex-col", { variants: { gap }, defaultVariants: { gap: "stack" } });

const inlineVariants = cva("flex items-center", {
	variants: {
		gap,
		justify: { start: "", between: "justify-between", end: "justify-end", center: "justify-center" },
		wrap: { true: "flex-wrap", false: "" },
	},
	defaultVariants: { gap: "control", justify: "start", wrap: true },
});

type StackProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof stackVariants>;
type InlineProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof inlineVariants>;

// Vertical rhythm: control for a label and its field, stack for items in a group, section between groups.
const Stack = React.forwardRef<HTMLDivElement, StackProps>(({ className, gap, ...props }, ref) => (
	<div ref={ref} className={cn(stackVariants({ gap }), className)} {...props} />
));
Stack.displayName = "Stack";

// Things side by side: buttons, chips, a name and its badge.
const Inline = React.forwardRef<HTMLDivElement, InlineProps>(({ className, gap, justify, wrap, ...props }, ref) => (
	<div ref={ref} className={cn(inlineVariants({ gap, justify, wrap }), className)} {...props} />
));
Inline.displayName = "Inline";

export { Stack, Inline };
