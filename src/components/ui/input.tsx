import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Fields are a line to write on, not a box. `amount` is the big money field in the editors; `code`
// is the six-digit sign-in code.
const inputVariants = cva(
	"flex w-full min-w-0 bg-transparent text-ink outline-none transition-[border-color] duration-150 placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-owe-mark",
	{
		variants: {
			variant: {
				default:
					"type-body-lg h-11 rounded-none border-0 border-b-[1.5px] border-input px-0 focus-visible:border-ink focus-visible:outline-none",
				boxed:
					"type-body h-control rounded-full border-[1.5px] border-input px-5 focus-visible:border-ink focus-visible:outline-none",
				amount: "type-stat-xl h-auto border-0 p-0 focus-visible:outline-none",
				code: "type-h2 h-16 rounded-lg border-[1.5px] border-input text-center tracking-[0.4em] focus-visible:border-ink focus-visible:outline-none",
			},
		},
		defaultVariants: { variant: "default" },
	}
);

type InputProps = React.ComponentProps<"input"> & VariantProps<typeof inputVariants>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, variant, type, ...props }, ref) => (
	<input type={type} className={cn(inputVariants({ variant }), className)} ref={ref} {...props} />
));
Input.displayName = "Input";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
	({ className, ...props }, ref) => (
		<textarea
			ref={ref}
			className={cn(
				"type-body flex min-h-24 w-full resize-y rounded-lg border-[1.5px] border-input bg-transparent px-4 py-3 text-ink outline-none placeholder:text-muted-foreground/70 focus-visible:border-ink focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
				className
			)}
			{...props}
		/>
	)
);
Textarea.displayName = "Textarea";

export { Input, Textarea, inputVariants };
