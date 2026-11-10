import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// A short fact pinned to a row: "Owner", "Not synced yet", "Needs resolving". Tones carry meaning:
// waiting is marigold, owe is tomato, settled is mint, owed is cobalt.
const badgeVariants = cva(
	"type-caption inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 font-medium [&_svg]:size-3.5 [&_svg]:shrink-0",
	{
		variants: {
			tone: {
				neutral: "bg-sunken text-ink",
				outline: "border border-border-strong text-muted-foreground",
				waiting: "bg-waiting/30 text-ink",
				owe: "bg-owe-mark/15 text-owe",
				owed: "bg-primary/10 text-owed",
				settled: "bg-settled/40 text-ink",
				ink: "bg-ink text-paper",
			},
		},
		defaultVariants: { tone: "neutral" },
	}
);

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

function Badge({ className, tone, ...props }: BadgeProps) {
	return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };
