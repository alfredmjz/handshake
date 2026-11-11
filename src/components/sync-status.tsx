import type { ComponentProps } from "react";

import { HAND_BLOB } from "@/components/art/art-markup";
import { HandsGlyph, type HandsPose } from "@/components/art/hands-glyph";
import { useWaitingChanges } from "@/lib/groups";
import { requestSync, useSyncStatus, type SyncStatus } from "@/lib/sync/controller";
import { cn } from "@/lib/utils";

export type SyncState = "synced" | "syncing" | "waiting" | "offline" | "error";

// The blob is the same one that sits behind every category hand; its colour and the hands' pose say the state.
const LOOK: Record<SyncState, { fill: string | null; pose: HandsPose }> = {
	synced: { fill: "hsl(var(--settled))", pose: "clasped" },
	syncing: { fill: "hsl(var(--settled) / 0.45)", pose: "shaking" },
	waiting: { fill: "hsl(var(--waiting))", pose: "clasped" },
	offline: { fill: null, pose: "apart" },
	error: { fill: "hsl(var(--owe-mark))", pose: "apart" },
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

// A stamp in the margin: the two hands on a tinted blob. Clasped when everything is on the server, shaking
// while it syncs, apart when offline or failing. Changes still waiting show as a small tilted count tag.
export function SyncStamp({
	state,
	waiting = 0,
	className,
	...props
}: Omit<ComponentProps<"button">, "children"> & { state: SyncState; waiting?: number }) {
	const { fill, pose } = LOOK[state];
	return (
		<button
			type="button"
			{...props}
			className={cn(
				"relative inline-flex size-tap shrink-0 items-center justify-center rounded-full transition-transform hover:-rotate-3 active:scale-95",
				className
			)}
		>
			<svg viewBox="0 0 80 80" aria-hidden className="absolute inset-0 size-full overflow-visible">
				<path
					transform="translate(40 40) rotate(-8) scale(1.4) translate(-40 -37)"
					d={HAND_BLOB}
					style={
						fill
							? { fill }
							: { fill: "none", stroke: "hsl(var(--ink) / 0.55)", strokeWidth: 2.4, strokeDasharray: "5 5" }
					}
				/>
			</svg>
			<HandsGlyph
				pose={pose}
				strokeWidth={5.5}
				className={cn("relative h-5 w-[1.875rem]", state === "offline" && "opacity-60")}
			/>
			{waiting > 0 && state !== "synced" && (
				<span className="type-micro absolute -right-1.5 -top-1 flex h-5 min-w-5 rotate-6 items-center justify-center rounded-full border-[1.5px] border-ink bg-paper px-1 font-semibold tabular-nums text-ink">
					{waiting > 9 ? "9+" : waiting}
				</span>
			)}
		</button>
	);
}

// Tap to sync now. The words live in the tooltip and for screen readers; the drawing says it at a glance.
export function SyncStatusBadge() {
	const status = useSyncStatus();
	const waiting = useWaitingChanges() ?? 0;
	const { state, spoken } = describe(status, waiting);

	return (
		<SyncStamp
			state={state}
			waiting={waiting}
			onClick={requestSync}
			aria-label={`${spoken}. Sync now`}
			title={status.state === "error" ? `Couldn't reach the server (${status.error}). Tap to try again.` : spoken}
			aria-live="polite"
		/>
	);
}
