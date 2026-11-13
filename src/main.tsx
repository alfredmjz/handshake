import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { polyfillCountryFlagEmojis } from "country-flag-emoji-polyfill";
import flagFont from "country-flag-emoji-polyfill/dist/TwemojiCountryFlags.woff2?url";

import "@fontsource-variable/funnel-display";
import "@fontsource-variable/funnel-sans";
import "@fontsource-variable/shantell-sans/full.css";
import "sonner/dist/styles.css";
import "@/styles/globals.css";
import { App } from "@/app";

// Windows draws no flag emoji, only their letters ("JP"); there, stickers take the flags from this font, served
// with the app so it works offline.
polyfillCountryFlagEmojis("Twemoji Country Flags", flagFont);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</StrictMode>
);
