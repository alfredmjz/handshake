import { useEffect, useRef } from "react";
import { Link } from "react-router";

import { HandDisc, type HandKind } from "@/components/art/hand";
import { CoverSticker } from "@/components/cover-sticker";
import { Circled } from "@/components/art/marks";
import { Amount, RollingAmount } from "@/components/money";
import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";

export type ReceiptBill = {
	id: string;
	description: string;
	amountCents: number;
	// A bill's named items, printed under it; empty when it is one amount.
	items: { id: string; description: string; amountCents: number }[];
	href: string;
};

type GroupReceiptProps = {
	name: string;
	note: string | null;
	kind: HandKind;
	// The group's sticker, in the corner in place of the hand.
	sticker?: string | null;
	// Every bill, oldest first, so the newest prints at the bottom like a till roll.
	bills: ReceiptBill[];
	totalCents: number;
	myShareCents: number;
	// Where "3 earlier" goes: the Entries tab.
	entriesHref: string;
	// Arriving from the shelf: the receipt prints out from the top.
	printing?: boolean;
	className?: string;
};

const SHOWN = 5;
const FEED_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

function Leader() {
	return <span aria-hidden className="mb-1 min-w-4 flex-1 self-end border-b-2 border-dotted border-ink/20" />;
}

// The group's tab: what was bought and what it all cost, and your share of it.
export function GroupReceipt({
	name,
	note,
	kind,
	sticker,
	bills,
	totalCents,
	myShareCents,
	entriesHref,
	printing = false,
	className,
}: GroupReceiptProps) {
	const paper = useRef<HTMLDivElement>(null);
	const lastTotal = useRef(totalCents);
	// Bills on the receipt when it was printed stay put; a bill added after prints in at the bottom.
	const printed = useRef<Set<string> | null>(null);
	printed.current ??= new Set(bills.map((b) => b.id));

	// When the total changes the till feeds the paper on a line, after any closing editor is out of the way.
	useEffect(() => {
		if (lastTotal.current === totalCents) return;
		lastTotal.current = totalCents;
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		paper.current?.animate(
			[{ transform: "translateY(0)" }, { transform: "translateY(-0.5rem)" }, { transform: "translateY(0)" }],
			{ duration: 620, delay: 280, easing: FEED_EASE }
		);
	}, [totalCents]);

	const shown = bills.slice(-SHOWN);
	const earlier = bills.length - shown.length;

	return (
		<div className={cn("receipt-shadow", className)}>
			<div
				ref={paper}
				className={cn("receipt-torn flex flex-col bg-raised px-panel pb-7 pt-panel", printing && "animate-print")}
			>
				<div className="flex items-start justify-between gap-stack">
					<div className="flex min-w-0 flex-col gap-0.5">
						<h1 className="type-h3 line-clamp-2 break-words uppercase tracking-[0.02em]">{name}</h1>
						{note && <p className="type-body-sm line-clamp-1 break-words text-muted-foreground">{note}</p>}
					</div>
					{sticker ? (
						<CoverSticker sticker={sticker} fallback={kind} size="2.75rem" />
					) : (
						<HandDisc kind={kind} size={44} />
					)}
				</div>

				<hr className="my-stack border-t-[1.5px] border-dashed border-ink/25" />

				{bills.length === 0 ? (
					<p className="type-body-sm text-muted-foreground">Nothing on the tab yet</p>
				) : (
					<ul className="flex flex-col">
						{earlier > 0 && (
							<li className="pb-1">
								<Link to={entriesHref} className="type-label text-muted-foreground underline underline-offset-4">
									{earlier} earlier
								</Link>
							</li>
						)}
						{shown.map((bill) => (
							<li
								key={bill.id}
								className={cn(
									!printed.current?.has(bill.id) &&
										"[animation:land_var(--duration-moment)_var(--ease-bounce)_280ms_both]"
								)}
							>
								<Link
									to={bill.href}
									className="-mx-2 flex flex-col rounded-md px-2 py-1 transition-colors duration-quick ease-out hover:bg-ink/5"
								>
									<span className="flex items-center gap-control">
										<span className="type-body-sm min-w-0 truncate font-medium">{bill.description}</span>
										<Leader />
										<Amount cents={bill.amountCents} className="tabular-nums" />
									</span>
									{bill.items.map((item) => (
										<span key={item.id} className="flex items-center gap-control pl-stack text-muted-foreground">
											<span className="type-label min-w-0 truncate">{item.description}</span>
											<Leader />
											<span className="type-label tabular-nums">{formatAmount(item.amountCents)}</span>
										</span>
									))}
								</Link>
							</li>
						))}
					</ul>
				)}

				<hr className="my-stack border-t-[1.5px] border-dashed border-ink/25" />

				<div className="flex items-end justify-between gap-stack">
					<span className="type-label font-semibold uppercase tracking-[0.08em]">Total</span>
					<Circled delay={0.9} className="mr-4">
						<RollingAmount cents={totalCents} size="lg" />
					</Circled>
				</div>
				<div className="mt-1 flex items-center justify-between gap-stack text-muted-foreground">
					<span className="type-hand">your share</span>
					<RollingAmount cents={myShareCents} tone="inherit" className="type-label font-sans font-semibold" />
				</div>
			</div>
		</div>
	);
}
