import { useState } from "react";
import { useNavigate } from "react-router";

import { BellDoodle } from "@/components/art/doodles";
import { Face, FaceSlots } from "@/components/art/face";
import { Amount } from "@/components/money";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentUser } from "@/lib/auth";
import { useMembers } from "@/lib/members";
import { sentWhen, type ReceivedNudge } from "@/lib/nudge-view";
import { markNudgesSeen, useNudgesToMe, useUnseenNudgeCount } from "@/lib/nudges";
import { cn } from "@/lib/utils";

// The sender's face as drawn inside their group.
function SenderFace({ nudge }: { nudge: ReceivedNudge }) {
	const members = useMembers(nudge.groupId, { includeLeft: true });
	return (
		<FaceSlots members={members}>
			<Face seed={nudge.fromMemberId} name="" size={36} />
		</FaceSlots>
	);
}

// The header's bell: nudges sent to you across your groups, newest first; each opens that group's Balances.
export function NudgeBell() {
	const user = useCurrentUser();
	const navigate = useNavigate();
	const nudges = useNudgesToMe();
	const unseen = useUnseenNudgeCount();
	// The ones that were new when the bell opened stay marked while it's open.
	const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
	const now = new Date();

	return (
		<DropdownMenu
			onOpenChange={(open) => {
				if (!open) return;
				setFresh(new Set((nudges ?? []).filter((n) => n.unseen).map((n) => n.id)));
				void markNudgesSeen(user.id);
			}}
		>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label={unseen > 0 ? `Nudges, ${unseen} new` : "Nudges"}
					title="Nudges"
					className="relative rounded-full"
				>
					<BellDoodle ringing={unseen > 0} className="!size-[1.625rem]" />
					{unseen > 0 && (
						<span
							aria-hidden
							className="type-micro absolute -right-0.5 top-0 flex h-5 min-w-5 rotate-6 items-center justify-center rounded-full border-[1.5px] border-ink bg-owe-mark px-1 font-semibold tabular-nums text-paper"
						>
							{unseen > 9 ? "9+" : unseen}
						</span>
					)}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				collisionPadding={16}
				className="w-80 max-w-[var(--radix-dropdown-menu-content-available-width)]"
			>
				<DropdownMenuLabel>Nudges</DropdownMenuLabel>
				{nudges && nudges.length === 0 && <p className="type-body-sm px-3 py-row text-muted-foreground">No nudges</p>}
				{nudges?.map((nudge) => (
					<DropdownMenuItem
						key={nudge.id}
						className={cn("items-start py-control [&_svg]:size-full", fresh.has(nudge.id) && "bg-primary/10")}
						onSelect={() => navigate(`/groups/${nudge.groupId}?tab=balances`)}
					>
						<SenderFace nudge={nudge} />
						<span className="flex min-w-0 flex-col">
							<span>
								{nudge.fromName} nudged you · <Amount cents={nudge.amountCents} />
							</span>
							<span className="type-caption truncate text-muted-foreground">
								{nudge.groupName} · {sentWhen(nudge.createdAt, now)}
							</span>
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
