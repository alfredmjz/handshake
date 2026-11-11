import type * as React from "react";

import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return <div aria-hidden className={cn("animate-pulse rounded-lg bg-sunken", className)} {...props} />;
}

export { Skeleton };
