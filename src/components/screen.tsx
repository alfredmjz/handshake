import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Link } from "react-router";

import { cn } from "@/lib/utils";

type ScreenProps = {
	children: ReactNode;
	// narrow: one phone-width column, centred (lists, forms). wide: two columns from 1024px (a group).
	width?: "narrow" | "wide";
	className?: string;
};

// The page frame inside the signed-in layout: side gutters, a bottom margin, and a width.
export function Screen({ children, width = "narrow", className }: ScreenProps) {
	return (
		<div
			className={cn(
				"mx-auto flex w-full flex-col gap-section pb-section",
				width === "narrow" ? "max-w-xl" : "max-w-6xl",
				className
			)}
		>
			{children}
		</div>
	);
}

// Two columns from 1024px: the masthead (cover, actions) on the left, the content on the right.
export function ScreenColumns({ aside, children }: { aside: ReactNode; children: ReactNode }) {
	return (
		<div className="grid gap-section lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-x-spread">
			<div className="flex min-w-0 flex-col gap-section lg:sticky lg:top-section lg:self-start">{aside}</div>
			<div className="flex min-w-0 flex-col gap-section">{children}</div>
		</div>
	);
}

type ScreenHeaderProps = {
	title?: ReactNode;
	// Small line above the title ("Hi Alex").
	eyebrow?: ReactNode;
	// One line under the title ("Friends owe you $30.00 overall").
	lead?: ReactNode;
	back?: { to: string; label: string };
	actions?: ReactNode;
	className?: string;
};

export function ScreenHeader({ title, eyebrow, lead, back, actions, className }: ScreenHeaderProps) {
	return (
		<header className={cn("flex flex-col gap-control", className)}>
			{(back || actions) && (
				<div className="-mx-2 flex items-center justify-between gap-control">
					{back ? <BackLink to={back.to}>{back.label}</BackLink> : <span />}
					{actions && <div className="flex items-center gap-1">{actions}</div>}
				</div>
			)}
			{eyebrow && <div className="type-body-sm text-muted-foreground">{eyebrow}</div>}
			{title && <h1 className="type-h1 text-balance break-words">{title}</h1>}
			{lead && <p className="type-body">{lead}</p>}
		</header>
	);
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
	return (
		<Link
			to={to}
			className="type-body-sm inline-flex min-h-tap items-center gap-1 rounded-full pl-1 pr-3 font-medium transition-colors hover:bg-ink/5"
		>
			<ChevronLeft className="size-[1.375rem]" aria-hidden />
			{children}
		</Link>
	);
}

// A titled run of content within a screen.
export function Section({
	title,
	action,
	children,
	className,
}: {
	title?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("flex flex-col gap-stack", className)}>
			{(title || action) && (
				<div className="flex items-center justify-between gap-stack">
					{title && <h2 className="type-h4">{title}</h2>}
					{action}
				</div>
			)}
			{children}
		</section>
	);
}
