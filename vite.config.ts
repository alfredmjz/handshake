import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
	plugins: [
		react(),
		// Caches the app shell so the web version opens with no connection. The native app bundles the
		// same build, so it never needs the network to start.
		VitePWA({
			registerType: "autoUpdate",
			includeAssets: ["favicon.svg"],
			manifest: {
				name: "Handshake",
				short_name: "Handshake",
				description: "Track who owes who in your friend group and plan trips together.",
				theme_color: "#f8f7f4",
				background_color: "#f8f7f4",
				display: "standalone",
				icons: [{ src: "favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
			},
			workbox: {
				navigateFallback: "/index.html",
				// The API is served by the Vercel function, never by the app shell.
				navigateFallbackDenylist: [/^\/api\//],
				globPatterns: ["**/*.{js,css,html,svg,woff2}"],
			},
		}),
	],
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	server: { port: 5173, strictPort: true },
});
