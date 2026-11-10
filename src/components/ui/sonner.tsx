import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const tokens = {
	"--normal-bg": "hsl(var(--ink))",
	"--normal-border": "hsl(var(--ink))",
	"--normal-text": "hsl(var(--paper))",
	"--success-bg": "hsl(var(--ink))",
	"--success-border": "hsl(var(--ink))",
	"--success-text": "hsl(var(--paper))",
	"--error-bg": "hsl(var(--owe))",
	"--error-border": "hsl(var(--owe))",
	"--error-text": "hsl(var(--paper))",
	"--warning-bg": "hsl(var(--waiting))",
	"--warning-border": "hsl(var(--waiting))",
	"--warning-text": "hsl(var(--ink))",
	"--border-radius": "var(--radius)",
} as CSSProperties;

// Toasts are ink notes on the paper; errors are tomato.
const Toaster = (props: ToasterProps) => (
	<Sonner
		className="toaster group"
		theme="light"
		style={tokens}
		toastOptions={{
			classNames: {
				toast: "font-sans type-body-sm shadow-pop",
				description: "type-label !text-current opacity-85",
			},
		}}
		{...props}
	/>
);

export { Toaster };
