import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Chips to pick from: one (Paid by) or several (Split between). Picked chips are inked (single)
// or cobalt-outlined (multiple); unpicked ones in a multiple group are dashed, like a gap to fill.
const chipVariants = cva(
	"type-body-sm inline-flex h-chip shrink-0 items-center gap-[0.4375rem] whitespace-nowrap rounded-full border-[1.5px] pl-[5px] pr-3 font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
	{
		variants: {
			look: {
				single:
					"border-border-strong text-ink hover:border-ink data-[state=on]:border-ink data-[state=on]:bg-ink data-[state=on]:font-semibold data-[state=on]:text-paper",
				multiple:
					"border-dashed border-ink/30 text-muted-foreground hover:border-ink/60 data-[state=on]:border-solid data-[state=on]:border-primary data-[state=on]:bg-primary/[0.08] data-[state=on]:font-semibold data-[state=on]:text-ink [&[data-state=off]_[data-chip-art]]:opacity-45",
				plain: "border-transparent px-0 pl-0 pr-0",
			},
		},
		defaultVariants: { look: "single" },
	}
);

const ToggleGroup = React.forwardRef<
	React.ElementRef<typeof ToggleGroupPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
	<ToggleGroupPrimitive.Root ref={ref} className={cn("flex flex-wrap gap-control", className)} {...props} />
));
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName;

type ItemProps = React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof chipVariants>;

const ToggleGroupItem = React.forwardRef<React.ElementRef<typeof ToggleGroupPrimitive.Item>, ItemProps>(
	({ className, look, ...props }, ref) => (
		<ToggleGroupPrimitive.Item ref={ref} className={cn(chipVariants({ look }), className)} {...props} />
	)
);
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName;

export { ToggleGroup, ToggleGroupItem, chipVariants };
