import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

// shadcn/ui token names; the values live in src/styles/globals.css. Colours take Tailwind's alpha
// modifier (`border-ink/10`), so translucent lines and washes come from the same tokens.
const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

const config: Config = {
	content: ["./index.html", "./src/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				background: token("background"),
				foreground: token("foreground"),
				card: { DEFAULT: token("card"), foreground: token("card-foreground") },
				popover: { DEFAULT: token("popover"), foreground: token("popover-foreground") },
				primary: { DEFAULT: token("primary"), foreground: token("primary-foreground"), hover: token("primary-hover") },
				secondary: { DEFAULT: token("secondary"), foreground: token("secondary-foreground") },
				muted: { DEFAULT: token("muted"), foreground: token("muted-foreground") },
				accent: { DEFAULT: token("accent"), foreground: token("accent-foreground") },
				destructive: { DEFAULT: token("destructive"), foreground: token("destructive-foreground") },
				border: { DEFAULT: "hsl(var(--ink) / 0.12)", strong: "hsl(var(--ink) / 0.22)" },
				input: "hsl(var(--ink) / 0.22)",
				ring: token("ring"),

				// The page itself: paper, the ink drawn on it, a raised sheet and a sunken well.
				paper: token("paper"),
				ink: token("ink"),
				raised: token("raised"),
				sunken: token("sunken"),

				// Money: owed to you is cobalt, you owe is tomato; settled and waiting for a handshake.
				owed: token("owed"),
				owe: { DEFAULT: token("owe"), mark: token("owe-mark") },
				settled: token("settled"),
				waiting: token("waiting"),

				// One colour per category, used for covers, hand discs and chips.
				category: {
					food: token("category-food"),
					drinks: token("category-drinks"),
					stay: token("category-stay"),
					travel: token("category-travel"),
					groceries: token("category-groceries"),
					fun: token("category-fun"),
					none: token("category-none"),
				},
			},
			borderRadius: {
				lg: "var(--radius)",
				md: "calc(var(--radius) - 4px)",
				sm: "calc(var(--radius) - 8px)",
				xl: "calc(var(--radius) + 4px)",
				sheet: "var(--radius-sheet)",
				// A notebook: square at the spine, round at the fore-edge.
				book: "var(--radius-book-spine) var(--radius-book-edge) var(--radius-book-edge) var(--radius-book-spine)",
			},
			fontFamily: {
				sans: ["var(--font-sans)"],
				display: ["var(--font-display)"],
			},
			spacing: {
				control: "var(--space-control)",
				stack: "var(--space-stack)",
				section: "var(--space-section)",
				panel: "var(--space-panel)",
				row: "var(--space-row)",
				page: "var(--space-page)",
				spread: "var(--space-spread)",
				tap: "var(--size-tap)",
			},
			height: {
				control: "var(--size-control)",
				"control-lg": "var(--size-control-lg)",
				chip: "var(--size-chip)",
			},
			boxShadow: {
				raised: "var(--shadow-raised)",
				pop: "var(--shadow-pop)",
				selected: "var(--shadow-selected)",
			},
			transitionTimingFunction: {
				out: "var(--ease-out)",
				"in-out": "var(--ease-in-out)",
				spring: "var(--ease-spring)",
				bounce: "var(--ease-bounce)",
			},
			transitionDuration: {
				press: "var(--duration-press)",
				quick: "var(--duration-quick)",
				settle: "var(--duration-settle)",
				moment: "var(--duration-moment)",
			},
			keyframes: {
				// A new bill or payment is put down on the page: it drops in, tilted, and settles flat.
				draw: { to: { strokeDashoffset: "0" } },
				land: {
					from: { opacity: "0", transform: "translateY(-1.5rem) rotate(-2deg) scale(0.97)" },
					"35%": { opacity: "1" },
					to: { opacity: "1", transform: "none" },
				},
				// What just changed keeps a cobalt wash until you've had a moment to see it.
				"just-changed": {
					"0%, 60%": { backgroundColor: "hsl(var(--primary) / 0.14)" },
					"100%": { backgroundColor: "hsl(var(--primary) / 0)" },
				},
				// Opening a group prints its receipt: the paper comes out of the top, a line at a time.
				print: {
					from: { clipPath: "inset(0 0 100% 0)", transform: "translateY(-1rem)" },
					to: { clipPath: "inset(0 0 0 0)", transform: "none" },
				},
				"hand-in-left": {
					"0%": { transform: "translateX(-46px)", opacity: "0" },
					"40%, 100%": { transform: "translateX(0)", opacity: "1" },
				},
				"hand-in-right": {
					"0%": { transform: "translateX(46px)", opacity: "0" },
					"40%, 100%": { transform: "translateX(0)", opacity: "1" },
				},
				shake: {
					"0%, 42%": { transform: "translateY(0)" },
					"52%": { transform: "translateY(-3.5px)" },
					"62%": { transform: "translateY(3px)" },
					"72%": { transform: "translateY(-2.5px)" },
					"82%": { transform: "translateY(2px)" },
					"92%, 100%": { transform: "translateY(0)" },
				},
				"sign-off": { from: { clipPath: "inset(0 100% 0 0)" }, to: { clipPath: "inset(0 0 0 0)" } },
				rise: { from: { opacity: "0", transform: "translateY(10px)" }, to: { opacity: "1", transform: "none" } },
			},
			animation: {
				land: "land var(--duration-settle) var(--ease-bounce) both",
				"just-changed": "just-changed 4s var(--ease-out) both",
				print: "print 0.9s var(--ease-out) 0.12s both",
				"hand-in-left": "hand-in-left 1.9s cubic-bezier(.3,.7,.2,1) both",
				"hand-in-right": "hand-in-right 1.9s cubic-bezier(.3,.7,.2,1) both",
				shake: "shake 1.9s ease-in-out both",
				"sign-off": "sign-off 1s ease-out 1.6s both",
				rise: "rise .5s ease-out 1.1s both",
			},
		},
	},
	plugins: [animate],
};

export default config;
