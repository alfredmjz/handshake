import type { CapacitorConfig } from "@capacitor/cli";

// The native app ships the built files in dist/ instead of loading a hosted site, so it opens offline.
const config: CapacitorConfig = {
	appId: "com.alfredmjz.handshake",
	appName: "Handshake",
	webDir: "dist",
};

export default config;
