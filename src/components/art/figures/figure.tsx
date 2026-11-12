import { useEffect, useRef } from "react";

import { hairlineTokens } from "@/components/ui/hairline";
import { cn } from "@/lib/utils";
import { HL } from "@/vendor/hairline/kernel";

export type FigureRead = { textContent: string };
export type FigureHandle = { set: (value: number) => void; destroy: () => void };
export type FigureMount = (
	parts: { stage: HTMLElement; svg: SVGSVGElement; read: FigureRead },
	value: number
) => FigureHandle;

// Mounts one of our own figures on Hairline's kernel, as the skill's bench does: the stage, a 400 × 320 svg, and a
// read-out kept for screen readers. The figure answers the pointer and sleeps when nothing moves.
export function HairlineFigure({
	mount,
	value,
	label,
	className,
}: {
	mount: FigureMount;
	value: number;
	// What the figure shows, for screen readers; leave empty when the words beside it say it already.
	label?: string;
	className?: string;
}) {
	const stageRef = useRef<HTMLDivElement>(null);
	const handleRef = useRef<FigureHandle | null>(null);

	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		HL.inject(document);
		const svg = HL.mk("svg", { viewBox: "0 0 400 320", "aria-hidden": "true" }, stage) as SVGSVGElement;
		const read: FigureRead = { textContent: "rest" };
		const handle = mount({ stage, svg, read }, value);
		handleRef.current = handle;
		return () => {
			handle.destroy();
			svg.remove();
			handleRef.current = null;
		};
		// Mounted once per figure; a new value goes through set below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mount]);

	useEffect(() => {
		handleRef.current?.set(value);
	}, [value]);

	return (
		<div
			ref={stageRef}
			data-hairline=""
			{...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
			className={cn("shrink-0", className)}
			style={hairlineTokens}
		/>
	);
}
