import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The spacing and size tokens are listed so cn() lets a later p-0 override p-panel or h-9 override h-control.
// Type roles are `type-*` component classes, not Tailwind font sizes, so they never clash with text colours.
const twMerge = extendTailwindMerge<"type">({
	extend: {
		theme: {
			spacing: ["control", "stack", "section", "panel", "row", "page", "spread", "tap"],
		},
		classGroups: {
			type: [
				{
					type: [
						"display",
						"h1",
						"h2",
						"h3",
						"h4",
						"cover",
						"body",
						"body-lg",
						"body-sm",
						"label",
						"caption",
						"micro",
						"hand",
						"hand-lg",
						"control",
						"wordmark",
						"money",
						"money-lg",
						"stat",
						"stat-xl",
					],
				},
			],
			h: [{ h: ["control", "control-lg", "chip"] }],
			rounded: [{ rounded: ["sheet", "book"] }],
			shadow: [{ shadow: ["raised", "pop", "selected"] }],
		},
	},
});

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// Lists and pickers sort by the label people read, case-insensitive.
export function byText<T>(label: (item: T) => string) {
	return (a: T, b: T) => label(a).localeCompare(label(b), undefined, { sensitivity: "base" });
}
