import { CloudOff, RefreshCw, TriangleAlert } from "lucide-react";

import { Hand } from "@/components/art/hand";
import { badgeVariants } from "@/components/ui/badge";
import { useWaitingChanges } from "@/lib/groups";
import { requestSync, useSyncStatus, type SyncStatus } from "@/lib/sync/controller";
import { cn } from "@/lib/utils";

type Described = {
	icon: "shake" | "syncing" | "offline" | "error";
	label: string;
	spoken: string;
	tone: "neutral" | "waiting" | "owe" | "outline" | "synced";
};

function describe(status: SyncStatus, waiting: number): Described {
	const pending = waiting > 0 ? `, ${waiting} ${waiting === 1 ? "change" : "changes"} waiting` : "";
	switch (status.state) {
		case "offline":
			return {
				icon: "offline",
				label: waiting > 0 ? `${waiting} waiting` : "Offline",
				spoken: `Offline${pending}`,
				tone: "outline",
			};
		case "syncing":
			return { icon: "syncing", label: "Syncing", spoken: "Syncing", tone: "neutral" };
		case "error":
			return { icon: "error", label: "Not synced", spoken: `Not synced${pending}`, tone: "owe" };
		case "idle":
			return waiting > 0
				? { icon: "syncing", label: `${waiting} waiting`, spoken: `Online${pending}`, tone: "waiting" }
				: { icon: "shake", label: "Synced", spoken: "Synced", tone: "synced" };
	}
}

// Tap to sync now. Synced is mint with two hands agreeing; waiting is marigold; offline is an outline.
export function SyncStatusBadge() {
	const status = useSyncStatus();
	const waiting = useWaitingChanges() ?? 0;
	const { icon, label, spoken, tone } = describe(status, waiting);

	return (
		<button
			type="button"
			onClick={requestSync}
			aria-label={`${spoken}. Sync now`}
			title={status.state === "error" ? `Couldn't reach the server (${status.error}). Tap to try again.` : "Sync now"}
			aria-live="polite"
			className={cn(
				badgeVariants({ tone }),
				"h-9 gap-2 px-3.5 transition-[filter] hover:brightness-95 [&_svg]:size-[1.125rem]"
			)}
		>
			{/* The handshake is 3:2, so it gets its own box instead of the badge's square icon size. */}
			{icon === "shake" && <Hand kind="shake" size={36} className="!h-6 !w-9" />}
			{icon === "syncing" && <RefreshCw className={cn(status.state === "syncing" && "animate-spin")} aria-hidden />}
			{icon === "offline" && <CloudOff aria-hidden />}
			{icon === "error" && <TriangleAlert aria-hidden />}
			{label}
		</button>
	);
}
