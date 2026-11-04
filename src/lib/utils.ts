import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The custom type sizes are font sizes, not colours; without this, cn() would drop e.g. text-primary-foreground.
const twMerge = extendTailwindMerge({
	extend: {
		classGroups: {
			"font-size": [
				{
					text: [
						"display",
						"h1",
						"h2",
						"h3",
						"h4",
						"body-lg",
						"body",
						"body-sm",
						"body-xs",
						"label",
						"caption",
						"control",
						"value",
						"stat",
					],
				},
			],
		},
	},
});

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
