import type { ComponentProps } from "react";
import { cva } from "class-variance-authority";
import { CloudOff, RefreshCw, TriangleAlert } from "lucide-react";

import { Hand } from "@/components/art/hand";
import { useWaitingChanges } from "@/lib/groups";
import { requestSync, useSyncStatus, type SyncStatus } from "@/lib/sync/controller";
import { cn } from "@/lib/utils";

// A sticker tag: paper, an ink outline and a slight tilt, like the amount tags on payment cards.
const tag = cva(
	"type-caption inline-flex h-9 shrink-0 -rotate-2 items-center gap-2 whitespace-nowrap rounded-full border-[1.5px] border-ink px-3.5 font-medium text-ink transition-[filter] hover:brightness-95 [&_svg]:shrink-0",
	{
		variants: {
			tone: {
				synced: "bg-settled",
				waiting: "bg-waiting",
				syncing: "bg-paper",
				offline: "bg-paper text-muted-foreground",
				error: "bg-owe-mark",
			},
		},
	}
);

type SyncTone = "synced" | "waiting" | "syncing" | "offline" | "error";

type Described = {
	icon: "shake" | "syncing" | "waiting" | "offline" | "error";
	label: string;
	spoken: string;
	tone: SyncTone;
};

function describe(status: SyncStatus, waiting: number): Described {
	const pending = waiting > 0 ? `, ${waiting} ${waiting === 1 ? "change" : "changes"} waiting` : "";
	switch (status.state) {
		case "offline":
			return {
				icon: "offline",
				label: waiting > 0 ? `${waiting} waiting` : "Offline",
				spoken: `Offline${pending}`,
				tone: "offline",
			};
		case "syncing":
			return { icon: "syncing", label: "Syncing", spoken: "Syncing", tone: "syncing" };
		case "error":
			return { icon: "error", label: "Not synced", spoken: `Not synced${pending}`, tone: "error" };
		case "idle":
			return waiting > 0
				? { icon: "waiting", label: `${waiting} waiting`, spoken: `Online${pending}`, tone: "waiting" }
				: { icon: "shake", label: "Synced", spoken: "Synced", tone: "synced" };
	}
}

export function SyncTag({
	icon,
	label,
	tone,
	...props
}: Omit<ComponentProps<"button">, "children"> & Pick<Described, "icon" | "label" | "tone">) {
	return (
		<button type="button" {...props} className={cn(tag({ tone }), props.className)}>
			{/* The handshake is 3:2, so it gets its own box. Synced it clasps, syncing it shakes, offline it is faded with a cloud. */}
			{(icon === "shake" || icon === "syncing") && (
				<Hand
					kind="shake"
					size={36}
					className={cn("!h-6 !w-9", icon === "syncing" && "animate-shake [animation-iteration-count:infinite]")}
				/>
			)}
			{icon === "waiting" && <RefreshCw className="size-[1.125rem]" aria-hidden />}
			{icon === "offline" && (
				<>
					<Hand kind="shake" size={36} className="!h-6 !w-9 opacity-35" />
					<CloudOff className="size-[1.125rem]" aria-hidden />
				</>
			)}
			{icon === "error" && <TriangleAlert className="size-[1.125rem]" aria-hidden />}
			{label}
		</button>
	);
}

// Tap to sync now. Synced is mint with two hands clasped; syncing shakes them; waiting is marigold; offline is outline only.
export function SyncStatusBadge() {
	const status = useSyncStatus();
	const waiting = useWaitingChanges() ?? 0;
	const { icon, label, spoken, tone } = describe(status, waiting);

	return (
		<SyncTag
			icon={icon}
			label={label}
			tone={tone}
			onClick={requestSync}
			aria-label={`${spoken}. Sync now`}
			title={status.state === "error" ? `Couldn't reach the server (${status.error}). Tap to try again.` : "Sync now"}
			aria-live="polite"
		/>
	);
}
