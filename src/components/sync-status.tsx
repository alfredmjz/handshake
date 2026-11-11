import { HandsGlyph, type HandsPose } from "@/components/art/hands-glyph";
import { useWaitingChanges } from "@/lib/groups";
import { useSyncStatus, type SyncStatus } from "@/lib/sync/controller";
import { cn } from "@/lib/utils";

export type SyncState = "synced" | "syncing" | "waiting" | "offline" | "error";

const POSE: Record<SyncState, HandsPose> = {
	synced: "clasped",
	syncing: "shaking",
	waiting: "clasped",
	offline: "apart",
	error: "apart",
};

function describe(status: SyncStatus, waiting: number): { state: SyncState; spoken: string } {
	const pending = waiting > 0 ? `, ${waiting} ${waiting === 1 ? "change" : "changes"} waiting` : "";
	switch (status.state) {
		case "offline":
			return { state: "offline", spoken: `Offline${pending}` };
		case "syncing":
			return { state: "syncing", spoken: "Syncing" };
		case "error":
			return { state: "error", spoken: `Not synced${pending}` };
		case "idle":
			return waiting > 0 ? { state: "waiting", spoken: `Online${pending}` } : { state: "synced", spoken: "Synced" };
	}
}

// Where this device stands with the server, in words and as a state for the mark.
export function useSyncState() {
	const status = useSyncStatus();
	const waiting = useWaitingChanges() ?? 0;
	return { ...describe(status, waiting), waiting, error: status.state === "error" ? status.error : null };
}

// The logo's hands say how the device stands with the server: clasped when everything is on it, shaking
// while it syncs, let go when offline or failing. Changes still waiting show as a small tilted count tag.
export function SyncMark({
	state,
	waiting = 0,
	className,
}: {
	state: SyncState;
	waiting?: number;
	className?: string;
}) {
	return (
		<span className={cn("relative inline-flex shrink-0", className)}>
			<HandsGlyph
				pose={POSE[state]}
				strokeWidth={4.4}
				className={cn("h-full w-full transition-opacity duration-quick ease-out", state === "offline" && "opacity-55")}
			/>
			{state === "error" ? (
				<span
					aria-hidden
					className="absolute -right-1 -top-0.5 size-2.5 rounded-full border-[1.5px] border-paper bg-owe-mark"
				/>
			) : (
				waiting > 0 &&
				state !== "synced" && (
					<span
						aria-hidden
						className="type-micro absolute -right-2.5 -top-1.5 flex h-[1.125rem] min-w-[1.125rem] rotate-6 animate-land items-center justify-center rounded-full border-[1.5px] border-ink bg-waiting px-1 font-semibold tabular-nums text-ink"
					>
						{waiting > 9 ? "9+" : waiting}
					</span>
				)
			)}
		</span>
	);
}
