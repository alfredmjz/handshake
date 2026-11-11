import { Face } from "@/components/art/face";
import { Amount } from "@/components/money";
import { Notice } from "@/components/notices";
import { Button } from "@/components/ui/button";
import { Inline } from "@/components/ui/stack";
import { openNudge } from "@/lib/nudge-view";
import { useLastNudge } from "@/lib/nudges";
import type { EntryRow } from "@/lib/sync/types";

type NudgeNoticeProps = {
	groupId: string;
	// The person who nudged (the one I owe) and me.
	fromId: string;
	fromName: string;
	meId: string;
	// The group's entries: a payment that counted since the nudge answers it.
	entries: EntryRow[];
	// Opens the payment editor for the nudge's amount; left out when I can't record a payment now.
	onPaid?: (amountCents: number) => void;
};

// "Alex nudged you · $20.00" on the card of a debt I still owe them, with Settle, until I pay them.
export function NudgeNotice({ groupId, fromId, fromName, meId, entries, onPaid }: NudgeNoticeProps) {
	const nudge = openNudge(useLastNudge(groupId, fromId, meId) ?? null, entries, fromId, meId);
	if (!nudge) return null;
	return (
		<Notice
			action={
				onPaid && (
					<Button size="sm" onClick={() => onPaid(nudge.amountCents)}>
						Settle
					</Button>
				)
			}
		>
			<Inline gap="control" wrap={false}>
				<Face seed={fromId} name="" size={28} />
				<span>
					{fromName} nudged you · <Amount cents={nudge.amountCents} />
				</span>
			</Inline>
		</Notice>
	);
}
