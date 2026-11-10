import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import "@fontsource-variable/funnel-display";
import "@fontsource-variable/funnel-sans";
import "sonner/dist/styles.css";
import "@/styles/globals.css";
import { App } from "@/app";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</StrictMode>
);
