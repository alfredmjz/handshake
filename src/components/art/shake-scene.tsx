import { cn } from "@/lib/utils";

const paperLine = {
	fill: "none",
	stroke: "hsl(var(--paper))",
	strokeWidth: 1.6,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

// Two sleeves slide in and shake on it: the moment a payment counts. The payer's sleeve takes their
// colour, the receiver's is marigold. Drawn in paper lines, for the cobalt confirmation screen.
export function ShakeScene({ payerTint, className }: { payerTint: string; className?: string }) {
	return (
		<svg viewBox="0 0 120 80" aria-hidden className={cn("overflow-visible", className)}>
			<g className="animate-shake">
				<g transform="rotate(-2 60 40)">
					<g className="animate-hand-in-left">
						<path
							style={{ fill: payerTint }}
							d="M-4 10.8 C 6 9.8, 15 9.6, 22.8 8.4 L 19.4 49.2 C 11 48.4, 3 48.8, -4 48.8 Z"
						/>
						<g style={paperLine}>
							<path d="M-4 10.4 C 2 9.8, 12.5 10.1, 16 9.5 C 19 9, 21.5 9.4, 23.6 8.6" />
							<path d="M-4 48.6 C 4 47.9, 10 48.9, 13.4 48.3 C 16 47.9, 18 48.6, 20 48.1" />
							<path d="M22.6 7.9 C 22.1 15, 21.3 22, 21 29 C 20.6 36, 19.7 42.5, 19.4 49.2" />
							<path d="M28.3 8.4 C 27.5 16, 27 23.5, 26.3 30.5 C 25.7 37.5, 24.9 43.5, 24.1 49" />
							<path d="M21.9 8.9 C 24 8.5, 26.2 8.8, 28.6 8.3 M18.8 48.6 C 20.7 48.9, 22.6 48.3, 24.9 48.7" />
							<path d="M27.4 12.9 C 31.5 12.2, 36.5 12.7, 43 11.8 C 47 11.4, 52 12.5, 57.4 12" />
							<path d="M24.3 48.6 C 28 52.5, 32.5 56, 37 60.6 C 40 63.8, 44 67.6, 47.4 71.2 C 49.5 74.6, 54.8 75.6, 57.9 72.6 C 60.6 69.9, 60.4 65.2, 58 61.6" />
							<path d="M56.2 58.7 C 58.6 61.4, 61 63.9, 63.6 66.6 C 66 69.4, 71.6 69.6, 74.2 66.2 C 76.4 63.2, 76.1 58.6, 74 55.9" />
							<path d="M67 48.1 C 69.9 51.2, 72.8 54.1, 76.1 57.1 C 78.7 59.9, 84 59.8, 86.6 56.6 C 89.1 53.6, 88.9 49.4, 86.7 46.9 C 82.4 42.4, 77.9 37.4, 73.6 32.9" />
						</g>
					</g>
					<g className="animate-hand-in-right">
						<path
							style={{ fill: "hsl(var(--category-drinks))" }}
							d="M97.9 8.2 C 106 9, 115 9, 124 9.8 L 124 48.4 C 115 48.4, 107 48.6, 101.7 49.1 Z"
						/>
						<g style={paperLine}>
							<path d="M73.6 32.9 C 71.2 29.8, 66.4 28.4, 62.2 29.6 C 60.2 30.2, 58.6 31.6, 57.2 33.2 L 54.6 36.1 C 52.2 38.8, 47.6 39.2, 44.6 36.6 C 41.5 33.9, 41.4 28.9, 44.2 25.9 C 47.4 22.4, 50.8 18.8, 54.4 15.1 C 58.6 11, 64.8 9.4, 70.4 9.7 C 74.2 9.9, 77.4 10.8, 80.6 12.4 C 82.6 13.6, 84.6 14.1, 86.6 13.8 C 88.6 13.4, 90.6 12.9, 93.2 12.6" />
							<path d="M92.2 9.1 C 93 16, 93.6 23.5, 94.4 30.5 C 95 37, 95.7 43, 96.5 48.9" />
							<path d="M97.9 8.2 C 98.6 15, 99.3 22.5, 99.9 29.5 C 100.5 36.5, 101 42.5, 101.7 49.1" />
							<path d="M91.6 8.9 C 93.8 8.4, 96 8.9, 98.6 8.4 M95.8 48.7 C 97.8 49.1, 99.8 48.4, 102.2 48.9" />
							<path d="M96.6 48.9 C 94 48.4, 91.5 48.9, 88.6 48.3" />
							<path d="M98.3 8.7 C 102 9.3, 105.6 8.6, 109.4 9.3 C 114 10, 119 9.2, 124 9.9" />
							<path d="M101.6 48.8 C 105 48.2, 108.5 49, 112 48.3 C 116 47.8, 120 48.4, 124 48.1" />
						</g>
					</g>
				</g>
			</g>
		</svg>
	);
}
