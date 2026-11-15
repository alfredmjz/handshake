import { useFaceTint } from "@/components/art/face";
import { ShakeScene } from "@/components/art/shake-scene";
import { Signatures } from "@/components/art/signatures";
import { useGroupView } from "@/components/group/group-data";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useEntry, useGroupSummary } from "@/lib/entries";
import { formatAmount } from "@/lib/money";
import { readPayment } from "@/lib/payment-rules";

export type ShakeConfirmationProps = {
	groupId: string;
	// The payment entry that just counted; null closes it.
	entryId: string | null;
	onClose: () => void;
};

// Both sign first, one after the other; then the sleeves come in and shake.
const SIGNING = 1.9;

// The cobalt moment when a payment counts: two hands shake, "Jo paid you $50.00", then "Settled".
export function ShakeConfirmation({ groupId, entryId, onClose }: ShakeConfirmationProps) {
	const entry = useEntry(entryId ?? "");
	const names = useGroupView(groupId)?.names;
	const summary = useGroupSummary(groupId);

	// It stays mounted on its screen, so the group has long loaded by the time a payment counts.
	const payment = entryId && entry && entry.kind === "payment" && names ? entry : null;
	const reading = payment ? readPayment(payment) : null;
	const { from, to } = reading ?? { from: undefined, to: undefined };
	const payerTint = useFaceTint(from ?? "");
	const line =
		payment && names ? `${names.of(from)} paid ${names.inSentence(to)} ${formatAmount(payment.amountCents)}` : "";
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
				{payment && names && (
					<>
						<ShakeScene
							key={payment.id}
							payerTint={payerTint}
							delay={SIGNING}
							className="-mx-page mt-section h-auto w-[calc(100%+2*var(--space-page))] max-w-md shrink-0 sm:mx-0 sm:w-full"
						/>
						{/* Inner spans: the dialog's own type roles would otherwise win over these. */}
						<DialogTitle className="mt-section">
							<span className="type-h2 block animate-rise text-balance [animation-delay:0.1s]">{line}</span>
						</DialogTitle>
						{/* People sign with their own name, you included. */}
						<Signatures
							tone="paper"
							signedOnly
							delay={0.5}
							payer={{ name: names.signed(from), role: "paid", signed: !!reading?.signed.payer }}
							receiver={{ name: names.signed(to), role: "received", signed: !!reading?.signed.receiver }}
							className="mx-auto mt-stack max-w-xs"
						/>
						<DialogDescription>
							<span
								className="type-display inline-block animate-sign-off font-bold text-primary-foreground"
								style={{ animationDelay: `${SIGNING + 1.6}s` }}
							>
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
