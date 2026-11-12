import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

export type Signer = {
	name: string;
	// Their part of the handshake, under the line: "paid", "received".
	role: string;
	signed: boolean;
};

type SignaturesProps = {
	payer: Signer;
	receiver: Signer;
	// Ink on paper, or paper on the cobalt confirmation screen.
	tone?: "ink" | "paper";
	// Seconds before the first signature is written; the second follows it.
	delay?: number;
	// Write the signatures out; off for a card that is only showing where things stand.
	write?: boolean;
	// Leave out a line nobody signed: a payment can count on the receiver's word alone.
	signedOnly?: boolean;
	className?: string;
};

function Line({
	signer,
	tone,
	delay,
	write,
}: {
	signer: Signer;
	tone: "ink" | "paper";
	delay: number;
	write: boolean;
}) {
	return (
		<span className="flex min-w-0 flex-1 flex-col gap-1">
			<span className="relative flex h-9 items-end px-1">
				{signer.signed ? (
					<span
						className={cn("signature truncate", write && "signature-write")}
						style={{ "--mark-delay": `${delay}s` } as CSSProperties}
					>
						{signer.name}
					</span>
				) : (
					// The cross a form leaves where someone still has to sign.
					<svg aria-hidden viewBox="0 0 12 12" className="mb-1 size-3 opacity-60">
						<path className="doodle" style={{ strokeWidth: 1.6, stroke: "currentColor" }} d="M2 2 L10 10 M10 2 L2 10" />
					</svg>
				)}
			</span>
			<span
				aria-hidden
				className={cn("border-t-2 border-dotted", tone === "ink" ? "border-ink/45" : "border-paper/60")}
			/>
			<span className={cn("type-caption px-1", !signer.signed && "opacity-60")}>
				<span className="sr-only">{signer.name}: </span>
				{signer.signed ? signer.role : `${signer.role}, not signed`}
			</span>
		</span>
	);
}

// The handshake on paper: a dotted line each, signed by whoever has done their part. One signature and
// a bare line is a payment still waiting; two is a payment that counts.
export function Signatures({
	payer,
	receiver,
	tone = "ink",
	delay = 0,
	write = true,
	signedOnly = false,
	className,
}: SignaturesProps) {
	const lines = [payer, receiver].filter((signer) => signer.signed || !signedOnly);
	return (
		<span className={cn("flex w-full gap-section text-left", tone === "ink" ? "text-ink" : "text-paper", className)}>
			{lines.map((signer, n) => (
				<Line key={signer.role} signer={signer} tone={tone} delay={delay + n * 0.75} write={write} />
			))}
		</span>
	);
}
