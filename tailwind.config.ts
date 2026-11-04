import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

// Same token names as Pholio (src/styles/globals.css there), so restyling is a matter of changing values.
const config: Config = {
	darkMode: ["class"],
	content: ["./index.html", "./src/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				background: "hsl(var(--background))",
				border: {
					DEFAULT: "hsl(var(--border))",
					strong: "hsl(var(--border-strong))",
				},
				ring: "hsl(var(--ring))",
				overlay: "hsl(var(--overlay))",
				field: {
					DEFAULT: "hsl(var(--field-bg))",
					border: "hsl(var(--field-border))",
					placeholder: "hsl(var(--field-placeholder))",
					focus: "hsl(var(--field-focus))",
				},
				text: {
					DEFAULT: "hsl(var(--text-primary))",
					muted: "hsl(var(--text-muted))",
					secondary: "hsl(var(--text-secondary))",
				},
				card: {
					DEFAULT: "hsl(var(--card))",
					foreground: "hsl(var(--card-foreground))",
					muted: "hsl(var(--card-muted))",
				},
				primary: {
					DEFAULT: "hsl(var(--primary))",
					foreground: "hsl(var(--primary-foreground))",
					hover: "hsl(var(--primary-hover))",
					border: "hsl(var(--primary-border))",
				},
				secondary: {
					DEFAULT: "hsl(var(--secondary))",
					foreground: "hsl(var(--secondary-foreground))",
					hover: "hsl(var(--secondary-hover))",
					muted: "hsl(var(--secondary-muted))",
					border: "hsl(var(--secondary-border))",
				},
				accent: {
					DEFAULT: "hsl(var(--accent))",
					foreground: "hsl(var(--accent-foreground))",
					muted: "hsl(var(--accent-muted))",
					playful: "hsl(var(--accent-playful))",
				},
				hover: {
					DEFAULT: "hsl(var(--hover))",
				},
				muted: {
					DEFAULT: "hsl(var(--card-muted))",
					foreground: "hsl(var(--text-muted))",
				},
				popover: {
					DEFAULT: "hsl(var(--popover))",
					foreground: "hsl(var(--popover-foreground))",
					muted: "hsl(var(--popover-muted))",
				},
				success: {
					DEFAULT: "hsl(var(--success))",
					foreground: "hsl(var(--success-foreground))",
					muted: "hsl(var(--success-muted))",
				},
				warning: {
					DEFAULT: "hsl(var(--warning))",
					foreground: "hsl(var(--warning-foreground))",
					muted: "hsl(var(--warning-muted))",
				},
				error: {
					DEFAULT: "hsl(var(--error))",
					foreground: "hsl(var(--error-foreground))",
					muted: "hsl(var(--error-muted))",
				},
				info: {
					DEFAULT: "hsl(var(--info))",
					foreground: "hsl(var(--info-foreground))",
					muted: "hsl(var(--info-muted))",
				},
			},
			borderRadius: {
				lg: "var(--radius)",
				md: "calc(var(--radius) - 2px)",
				sm: "calc(var(--radius) - 4px)",
			},
			fontFamily: {
				sans: ["Instrument Sans Variable", "Instrument Sans", "ui-sans-serif", "system-ui", "sans-serif"],
			},
			fontSize: {
				display: [
					"var(--type-display-size)",
					{
						lineHeight: "var(--type-display-leading)",
						letterSpacing: "var(--type-display-tracking)",
						fontWeight: "var(--type-display-weight)",
					},
				],
				h1: [
					"var(--type-h1-size)",
					{
						lineHeight: "var(--type-h1-leading)",
						letterSpacing: "var(--type-h1-tracking)",
						fontWeight: "var(--type-h1-weight)",
					},
				],
				h2: [
					"var(--type-h2-size)",
					{
						lineHeight: "var(--type-h2-leading)",
						letterSpacing: "var(--type-h2-tracking)",
						fontWeight: "var(--type-h2-weight)",
					},
				],
				h3: [
					"var(--type-h3-size)",
					{
						lineHeight: "var(--type-h3-leading)",
						letterSpacing: "var(--type-h3-tracking)",
						fontWeight: "var(--type-h3-weight)",
					},
				],
				h4: [
					"var(--type-h4-size)",
					{
						lineHeight: "var(--type-h4-leading)",
						letterSpacing: "var(--type-h4-tracking)",
						fontWeight: "var(--type-h4-weight)",
					},
				],
				"body-lg": ["var(--type-body-lg-size)", { lineHeight: "var(--type-body-lg-leading)" }],
				body: ["var(--type-body-size)", { lineHeight: "var(--type-body-leading)" }],
				"body-sm": ["var(--type-body-sm-size)", { lineHeight: "var(--type-body-sm-leading)" }],
				"body-xs": ["var(--type-body-xs-size)", { lineHeight: "var(--type-body-xs-leading)" }],
				label: [
					"var(--type-label-size)",
					{
						lineHeight: "var(--type-label-leading)",
						letterSpacing: "var(--type-label-tracking)",
						fontWeight: "var(--type-label-weight)",
					},
				],
				caption: ["var(--type-caption-size)", { lineHeight: "var(--type-caption-leading)" }],
				control: [
					"var(--type-control-size)",
					{ lineHeight: "var(--type-control-leading)", fontWeight: "var(--type-control-weight)" },
				],
				value: ["var(--type-value-size)", { lineHeight: "var(--type-control-leading)" }],
				stat: [
					"var(--type-stat-size)",
					{
						lineHeight: "var(--type-stat-leading)",
						letterSpacing: "var(--type-stat-tracking)",
						fontWeight: "var(--type-stat-weight)",
					},
				],
			},
			boxShadow: {
				card: "var(--shadow-card)",
				raised: "var(--shadow-raised)",
			},
		},
	},
	plugins: [animate],
};

export default config;
