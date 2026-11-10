import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Pill buttons. One loud thing per screen: the cobalt `default`. Everything else is ink outline,
// a soft well, or plain text.
const buttonVariants = cva(
	"type-control inline-flex shrink-0 items-center justify-center gap-control whitespace-nowrap rounded-full transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-5 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-primary-hover",
				outline: "border-[1.5px] border-ink bg-transparent text-ink hover:bg-ink/5",
				secondary: "bg-sunken text-ink hover:bg-ink/10",
				inverse: "bg-paper text-ink hover:bg-raised",
				destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
				ghost: "text-ink hover:bg-ink/5",
				link: "rounded-none font-medium text-ink underline underline-offset-4 hover:text-primary active:scale-100",
			},
			size: {
				default: "h-control px-5",
				sm: "h-chip px-4 type-body-sm font-semibold",
				lg: "h-control-lg px-6 type-body-lg font-semibold",
				icon: "size-tap",
				"icon-sm": "size-9 [&_svg]:size-4",
				inline: "h-auto px-0",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	}
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, asChild = false, type, ...props }, ref) => {
		const Comp = asChild ? Slot : "button";
		return (
			<Comp
				className={cn(buttonVariants({ variant, size, className }))}
				ref={ref}
				type={asChild ? undefined : (type ?? "button")}
				{...props}
			/>
		);
	}
);
Button.displayName = "Button";

export { Button, buttonVariants };
