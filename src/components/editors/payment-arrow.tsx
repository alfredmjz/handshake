import { SquiggleArrow } from "@/components/art/doodles";
import { Face } from "@/components/art/face";
import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";

type Person = { id: string; name: string };

// Who pays whom: the payer's face, a loopy arrow with the amount tag on it, the receiver's face.
export function PaymentArrow({
	from,
	to,
	amountCents,
	tilt = "up",
	size = 44,
	className,
}: {
	from: Person;
	to: Person;
	// Leave it out to draw the arrow without a tag (an amount still being typed).
	amountCents?: number | null;
	tilt?: "up" | "down";
	size?: number;
	className?: string;
}) {
	return (
		<div className={cn("flex items-center gap-1.5", className)}>
			<Face seed={from.id} name={from.name} size={size} />
			<span className="relative h-14 min-w-0 flex-1">
				<SquiggleArrow variant={tilt} className="absolute inset-0 size-full" />
				{amountCents != null && amountCents > 0 && (
					<span
						className={cn(
							"type-money absolute left-1/2 top-[-4px] -translate-x-1/2 whitespace-nowrap rounded-md border-[1.5px] border-ink bg-paper px-2.5 py-0.5",
							tilt === "up" ? "-rotate-[4deg]" : "rotate-[3deg]"
						)}
					>
						{formatAmount(amountCents)}
					</span>
				)}
			</span>
			<Face seed={to.id} name={to.name} size={size} />
		</div>
	);
}
