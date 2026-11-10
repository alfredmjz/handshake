import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";

import { CheckDoodle } from "@/components/art/doodles";
import { cn } from "@/lib/utils";

const Checkbox = React.forwardRef<
	React.ElementRef<typeof CheckboxPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
	<CheckboxPrimitive.Root
		ref={ref}
		className={cn(
			"peer inline-flex size-6 shrink-0 items-center justify-center rounded-md border-[1.5px] border-ink bg-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:bg-settled",
			className
		)}
		{...props}
	>
		<CheckboxPrimitive.Indicator className="flex items-center justify-center">
			<CheckDoodle className="size-4" />
		</CheckboxPrimitive.Indicator>
	</CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
