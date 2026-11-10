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
	tone: "neutral" | "waiting" | "owe" | "outline";
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
				: { icon: "shake", label: "Synced", spoken: "Synced", tone: "neutral" };
	}
}

// Tap to sync now. Synced shows two hands agreeing; waiting is marigold; offline is an outline.
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
			className={cn(badgeVariants({ tone }), "h-8 gap-1.5 px-3 transition-colors hover:bg-ink/10")}
		>
			{icon === "shake" && <Hand kind="shake" size={26} />}
			{icon === "syncing" && <RefreshCw className={cn(status.state === "syncing" && "animate-spin")} aria-hidden />}
			{icon === "offline" && <CloudOff aria-hidden />}
			{icon === "error" && <TriangleAlert aria-hidden />}
			{label}
		</button>
	);
}
