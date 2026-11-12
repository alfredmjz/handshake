import type { ReactNode } from "react";

import { Hand, type HandKind } from "@/components/art/hand";
import { cn } from "@/lib/utils";

// An empty screen is an invitation: a hand, one line, and the action that fills it.
export function EmptyState({
	kind = "new",
	art,
	title,
	action,
	className,
}: {
	kind?: HandKind;
	// In place of the hand: a hairline figure for a space that is waiting to fill. Every figure gets the same frame,
	// as wide as the tab and one height, so an empty tab looks the same whichever it is; a figure fills its height
	// (h-full), or the whole frame if it can draw at any width.
	art?: ReactNode;
	title: ReactNode;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex flex-col items-center gap-stack py-section text-center", className)}>
			{art ? <div className="flex h-56 w-full justify-center">{art}</div> : <Hand kind={kind} size={112} />}
			<p className="type-hand-lg max-w-xs text-balance">{title}</p>
			{action}
		</div>
	);
}

// A band across the top of a screen for something that stays true until acted on (you're a guest,
// this group is completed, you're offline).
export function Notice({
	tone = "neutral",
	icon,
	children,
	action,
	className,
}: {
	tone?: "neutral" | "waiting" | "owed";
	icon?: ReactNode;
	children: ReactNode;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			role="status"
			className={cn(
				"type-body-sm flex flex-wrap items-center gap-x-stack gap-y-control rounded-lg px-panel py-row",
				tone === "neutral" && "bg-sunken",
				tone === "waiting" && "bg-waiting/25",
				tone === "owed" && "bg-primary text-primary-foreground",
				className
			)}
		>
			{icon && <span className="shrink-0 [&_svg]:size-5">{icon}</span>}
			<span className="min-w-0 flex-1">{children}</span>
			{action}
		</div>
	);
}
