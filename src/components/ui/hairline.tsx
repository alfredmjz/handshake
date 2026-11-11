"use client";

import type { ComponentProps, CSSProperties } from "react";
import * as Hairline from "@lucasmarkes/hairline/react";

/**
 * hairline, wearing your theme. The six figures from @lucasmarkes/hairline,
 * with their palette mapped to shadcn's tokens, so they follow light, dark and
 * whatever you have made of them. A `style` you pass wins over the mapping.
 *
 * Docs: https://hairline.lucasmarkes.com
 */
// The theme's colours are HSL triples (Tailwind's alpha modifier needs them bare), so each is wrapped in hsl().
const tokens = {
	"--hairline-plate": "hsl(var(--background))",
	"--hairline-hi": "hsl(var(--foreground))",
	"--hairline-edge": "hsl(var(--muted-foreground))",
	"--hairline-mid": "color-mix(in oklab, hsl(var(--muted-foreground)) 55%, hsl(var(--background)))",
	"--hairline-lo": "hsl(var(--ink) / 0.22)",
	"--hairline-stroke": "1.1",
} as CSSProperties;

export function Riffle({ style, ...props }: ComponentProps<typeof Hairline.Riffle>) {
	return <Hairline.Riffle style={{ ...tokens, ...style }} {...props} />;
}

export function Terrain({ style, ...props }: ComponentProps<typeof Hairline.Terrain>) {
	return <Hairline.Terrain style={{ ...tokens, ...style }} {...props} />;
}

export function Exploded({ style, ...props }: ComponentProps<typeof Hairline.Exploded>) {
	return <Hairline.Exploded style={{ ...tokens, ...style }} {...props} />;
}

export function Phosphor({ style, ...props }: ComponentProps<typeof Hairline.Phosphor>) {
	return <Hairline.Phosphor style={{ ...tokens, ...style }} {...props} />;
}

export function Slow({ style, ...props }: ComponentProps<typeof Hairline.Slow>) {
	return <Hairline.Slow style={{ ...tokens, ...style }} {...props} />;
}

export function Turntable({ style, ...props }: ComponentProps<typeof Hairline.Turntable>) {
	return <Hairline.Turntable style={{ ...tokens, ...style }} {...props} />;
}

export function Keyboard({ style, ...props }: ComponentProps<typeof Hairline.Keyboard>) {
	return <Hairline.Keyboard style={{ ...tokens, ...style }} {...props} />;
}

export function Elevator({ style, ...props }: ComponentProps<typeof Hairline.Elevator>) {
	return <Hairline.Elevator style={{ ...tokens, ...style }} {...props} />;
}

export function Phone({ style, ...props }: ComponentProps<typeof Hairline.Phone>) {
	return <Hairline.Phone style={{ ...tokens, ...style }} {...props} />;
}

export function Laptop({ style, ...props }: ComponentProps<typeof Hairline.Laptop>) {
	return <Hairline.Laptop style={{ ...tokens, ...style }} {...props} />;
}

export function Terminal({ style, ...props }: ComponentProps<typeof Hairline.Terminal>) {
	return <Hairline.Terminal style={{ ...tokens, ...style }} {...props} />;
}

export function Cabinet({ style, ...props }: ComponentProps<typeof Hairline.Cabinet>) {
	return <Hairline.Cabinet style={{ ...tokens, ...style }} {...props} />;
}

export function Branches({ style, ...props }: ComponentProps<typeof Hairline.Branches>) {
	return <Hairline.Branches style={{ ...tokens, ...style }} {...props} />;
}

export function Vault({ style, ...props }: ComponentProps<typeof Hairline.Vault>) {
	return <Hairline.Vault style={{ ...tokens, ...style }} {...props} />;
}

export function Lockers({ style, ...props }: ComponentProps<typeof Hairline.Lockers>) {
	return <Hairline.Lockers style={{ ...tokens, ...style }} {...props} />;
}

export function Padlock({ style, ...props }: ComponentProps<typeof Hairline.Padlock>) {
	return <Hairline.Padlock style={{ ...tokens, ...style }} {...props} />;
}

export function Patch({ style, ...props }: ComponentProps<typeof Hairline.Patch>) {
	return <Hairline.Patch style={{ ...tokens, ...style }} {...props} />;
}

export function Dish({ style, ...props }: ComponentProps<typeof Hairline.Dish>) {
	return <Hairline.Dish style={{ ...tokens, ...style }} {...props} />;
}

export function Router({ style, ...props }: ComponentProps<typeof Hairline.Router>) {
	return <Hairline.Router style={{ ...tokens, ...style }} {...props} />;
}

export function Hub({ style, ...props }: ComponentProps<typeof Hairline.Hub>) {
	return <Hairline.Hub style={{ ...tokens, ...style }} {...props} />;
}

export function Relay({ style, ...props }: ComponentProps<typeof Hairline.Relay>) {
	return <Hairline.Relay style={{ ...tokens, ...style }} {...props} />;
}

export function Settle({ style, ...props }: ComponentProps<typeof Hairline.Settle>) {
	return <Hairline.Settle style={{ ...tokens, ...style }} {...props} />;
}

export function Format({ style, ...props }: ComponentProps<typeof Hairline.Format>) {
	return <Hairline.Format style={{ ...tokens, ...style }} {...props} />;
}

export function Rebuild({ style, ...props }: ComponentProps<typeof Hairline.Rebuild>) {
	return <Hairline.Rebuild style={{ ...tokens, ...style }} {...props} />;
}

export function Plot({ style, ...props }: ComponentProps<typeof Hairline.Plot>) {
	return <Hairline.Plot style={{ ...tokens, ...style }} {...props} />;
}

export function Stack({ style, ...props }: ComponentProps<typeof Hairline.Stack>) {
	return <Hairline.Stack style={{ ...tokens, ...style }} {...props} />;
}
