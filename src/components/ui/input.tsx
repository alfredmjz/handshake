import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
	({ className, type, ...props }, ref) => (
		<input
			type={type}
			className={cn(
				"flex h-10 w-full rounded-[10px] border border-field-border bg-field px-3 py-1 text-base text-primary shadow-sm transition-colors placeholder:text-field-placeholder focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-field-focus disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
				className
			)}
			ref={ref}
			{...props}
		/>
	)
);
Input.displayName = "Input";

export { Input };
