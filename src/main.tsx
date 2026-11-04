import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import "@fontsource-variable/instrument-sans";
import "sonner/dist/styles.css";
import "@/styles/globals.css";
import { App } from "@/app";
import { followSystemTheme } from "@/lib/theme";

followSystemTheme();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</StrictMode>
);
