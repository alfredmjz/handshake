import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

// Rows ruled with hairlines, like a ledger: leading art, a title with a line under it, and a value on the right.
const List = React.forwardRef<HTMLUListElement, React.HTMLAttributes<HTMLUListElement>>(
	({ className, ...props }, ref) => (
		<ul ref={ref} className={cn("flex flex-col divide-y divide-border", className)} {...props} />
	)
);
List.displayName = "List";

type ListRowProps = React.HTMLAttributes<HTMLElement> & {
	// Render the row as its child (a link or a button) so the whole line is the tap target.
	asChild?: boolean;
	leading?: React.ReactNode;
	title: React.ReactNode;
	subtitle?: React.ReactNode;
	trailing?: React.ReactNode;
};

const rowClass =
	"flex w-full min-w-0 items-center gap-stack py-row text-left outline-none transition-colors [&:is(a,button)]:cursor-pointer [&:is(a,button):hover]:bg-ink/[0.03] focus-visible:bg-ink/[0.05]";

const ListRow = React.forwardRef<HTMLElement, ListRowProps>(
	({ asChild = false, leading, title, subtitle, trailing, className, children, ...props }, ref) => {
		const content = (
			<>
				{leading && <span className="flex shrink-0 items-center">{leading}</span>}
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="type-body truncate font-semibold">
						<span className="marker marker-hover">{title}</span>
					</span>
					{subtitle && <span className="type-label truncate text-muted-foreground">{subtitle}</span>}
				</span>
				{trailing && <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">{trailing}</span>}
			</>
		);
		return (
			<li className="list-none">
				{asChild ? (
					<Slot ref={ref} className={cn(rowClass, className)} {...props}>
						{React.isValidElement(children)
							? React.cloneElement(children as React.ReactElement<{ children?: React.ReactNode }>, undefined, content)
							: content}
					</Slot>
				) : (
					<div ref={ref as React.Ref<HTMLDivElement>} className={cn(rowClass, className)} {...props}>
						{content}
						{children}
					</div>
				)}
			</li>
		);
	}
);
ListRow.displayName = "ListRow";

// A small heading over a run of rows: a day, "Everyone else", "Completed".
function ListHeading({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
	return <h2 className={cn("type-hand pb-1 pt-stack text-ink", className)} {...props} />;
}

export { List, ListRow, ListHeading };
