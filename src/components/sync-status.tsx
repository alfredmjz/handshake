import { Check, CircleAlert, Cloud, CloudOff, RefreshCw, type LucideIcon } from "lucide-react";

import { useWaitingChanges } from "@/lib/groups";
import { requestSync, useSyncStatus, type SyncStatus } from "@/lib/sync/controller";
import { cn } from "@/lib/utils";

function describe(status: SyncStatus, waiting: number): { label: string; Icon: LucideIcon; tone?: string } {
	const suffix = waiting > 0 ? ` · ${waiting} waiting` : "";
	switch (status.state) {
		case "offline":
			return { label: `Offline${suffix}`, Icon: CloudOff };
		case "syncing":
			return { label: "Syncing", Icon: RefreshCw, tone: "[&_svg]:animate-spin" };
		case "error":
			return { label: `Not synced${suffix}`, Icon: CircleAlert, tone: "border-error/40 text-error" };
		case "idle":
			return waiting > 0 ? { label: `${waiting} waiting`, Icon: Cloud } : { label: "Synced", Icon: Check };
	}
}

export function SyncStatusBadge() {
	const status = useSyncStatus();
	const waiting = useWaitingChanges();
	const { label, Icon, tone } = describe(status, waiting);

	return (
		<button
			type="button"
			onClick={requestSync}
			aria-label={`${label}. Sync now`}
			title={status.state === "error" ? `Couldn't reach the server (${status.error}). Tap to try again.` : "Sync now"}
			aria-live="polite"
			className={cn(
				"type-caption inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-muted-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				tone
			)}
		>
			<Icon className="size-3.5" aria-hidden />
			{label}
		</button>
	);
}
