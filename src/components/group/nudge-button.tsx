import { toast } from "sonner";

import type { GroupData } from "@/components/group/group-data";
import { useRun } from "@/components/group/use-run";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { canAnswer } from "@/lib/changes";
import { nudgedRecently } from "@/lib/nudge-view";
import { useLastNudge } from "@/lib/nudges";

// Nudge someone who owes you: once a day ("Nudged today"), never a name-only person ("Jo hasn't joined").
// Hidden when you may not nudge here (a completed group, your role) or they left.
export function NudgeButton({ data, memberId }: { data: GroupData; memberId: string }) {
	const run = useRun();
	const groupId = data.group?.id ?? "";
	const me = data.me?.id ?? "";
	const last = useLastNudge(groupId, me, memberId);
	const member = data.names.member(memberId);

	if (!data.can("nudge.send") || !member || member.deletedAt || last === undefined) return null;

	if (!canAnswer(member)) {
		return (
			<Button size="sm" variant="secondary" disabled>
				{member.displayName} hasn't joined
			</Button>
		);
	}

	if (nudgedRecently(last, new Date().toISOString())) {
		return (
			<>
				{last && data.unsynced.has(last.id) && <Badge tone="waiting">Not synced yet</Badge>}
				<Button size="sm" variant="secondary" disabled>
					Nudged today
				</Button>
			</>
		);
	}

	return (
		<Button
			size="sm"
			variant="secondary"
			onClick={async () => {
				const plan = await run({ type: "nudge", groupId, memberId });
				if (plan.ok) toast.success(`Nudged ${member.displayName}`);
			}}
		>
			Nudge
		</Button>
	);
}
