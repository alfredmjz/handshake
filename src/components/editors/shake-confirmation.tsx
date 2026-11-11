import { useFaceTint } from "@/components/art/face";
import { ShakeScene } from "@/components/art/shake-scene";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { paymentSides } from "@/lib/changes";
import { useEntry, useGroupSummary } from "@/lib/entries";
import { useMembers, useMyMember } from "@/lib/members";
import { formatAmount } from "@/lib/money";

export type ShakeConfirmationProps = {
	groupId: string;
	// The payment entry that just counted; null closes it.
	entryId: string | null;
	onClose: () => void;
};

// The cobalt moment when a payment counts: two hands shake, "Jo paid you $50.00", then "Settled".
export function ShakeConfirmation({ groupId, entryId, onClose }: ShakeConfirmationProps) {
	const entry = useEntry(entryId ?? "");
	const members = useMembers(groupId, { includeLeft: true });
	const me = useMyMember(groupId);
	const summary = useGroupSummary(groupId);

	const payment = entryId && entry && entry.kind === "payment" ? entry : null;
	const { from, to } = payment ? paymentSides(payment) : { from: undefined, to: undefined };
	// Names as people typed them; only "you" changes case at the start.
	const name = (id: string | undefined, start = false) =>
		id && id === me?.id ? (start ? "You" : "you") : (members?.find((m) => m.id === id)?.displayName ?? "Someone");
	const payerTint = useFaceTint(from ?? "");
	const line = payment ? `${name(from, true)} paid ${name(to)} ${formatAmount(payment.amountCents)}` : "";
	const square = !summary?.debts.some(
		(d) => (d.fromMemberId === from && d.toMemberId === to) || (d.fromMemberId === to && d.toMemberId === from)
	);

	return (
		<Dialog open={!!payment} onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				size="screen"
				hideClose
				className="items-center bg-primary text-center text-primary-foreground sm:max-w-md"
			>
				{payment && (
					<>
						<ShakeScene
							key={payment.id}
							payerTint={payerTint}
							className="-mx-page mt-section h-auto w-[calc(100%+2*var(--space-page))] max-w-md shrink-0 sm:mx-0 sm:w-full"
						/>
						{/* Inner spans: the dialog's own type roles would otherwise win over these. */}
						<DialogTitle className="mt-section">
							<span className="type-h2 block animate-rise text-balance">{line}</span>
						</DialogTitle>
						<DialogDescription>
							<span className="type-display inline-block animate-sign-off font-bold text-primary-foreground">
								{square ? "Settled" : "Shook on it"}
							</span>
						</DialogDescription>
						<div className="mt-auto w-full pt-section">
							<Button variant="inverse" size="lg" className="w-full" onClick={onClose}>
								Done
							</Button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
