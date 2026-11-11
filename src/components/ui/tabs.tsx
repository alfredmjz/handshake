import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

// A segmented control: a sunken pill track with the chosen tab inked in.
const Tabs = TabsPrimitive.Root;

// The ink pill is one piece that slides to the chosen tab on a spring, rather than jumping between them.
const TabsList = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.List>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, children, ...props }, ref) => {
	const listRef = React.useRef<HTMLDivElement | null>(null);
	const [pill, setPill] = React.useState<{ x: number; width: number; moved: boolean } | null>(null);

	React.useLayoutEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const measure = () => {
			const active = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
			if (!active) return;
			setPill((was) => ({ x: active.offsetLeft, width: active.offsetWidth, moved: was !== null }));
		};
		measure();
		const changes = new MutationObserver(measure);
		changes.observe(list, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
		const sizes = new ResizeObserver(measure);
		sizes.observe(list);
		return () => {
			changes.disconnect();
			sizes.disconnect();
		};
	}, []);

	return (
		<TabsPrimitive.List
			ref={(node) => {
				listRef.current = node;
				if (typeof ref === "function") ref(node);
				else if (ref) ref.current = node;
			}}
			className={cn("relative flex gap-1 rounded-full bg-sunken p-1", className)}
			{...props}
		>
			{pill && (
				<span
					aria-hidden
					className={cn(
						"absolute inset-y-1 left-0 rounded-full bg-ink",
						pill.moved && "transition-[transform,width] duration-settle ease-spring"
					)}
					style={{ width: pill.width, transform: `translateX(${pill.x}px)` }}
				/>
			)}
			{children}
		</TabsPrimitive.List>
	);
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
	<TabsPrimitive.Trigger
		ref={ref}
		className={cn(
			"type-body-sm relative inline-flex h-[2.375rem] flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 font-medium text-ink transition-colors duration-quick ease-out hover:bg-ink/5 data-[state=active]:font-semibold data-[state=active]:text-paper data-[state=active]:hover:bg-transparent",
			className
		)}
		{...props}
	/>
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
	<TabsPrimitive.Content ref={ref} className={cn("outline-none", className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
