import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { Clipboard } from "@capacitor/clipboard";

const CODE = /(?<![\d-])(\d{3})[ -]?(\d{3})(?![\d-])/g;

// The 6-digit code from a sign-in email in what someone copied: the code alone ("123456", "123 456") or a short
// line around it ("Your Handshake verification code is 123456."). Null for anything longer or with no single code.
export function emailedCodeIn(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.length > 80) return null;
	const codes = new Set([...trimmed.matchAll(CODE)].map((match) => match[1] + match[2]));
	return codes.size === 1 ? [...codes][0] : null;
}

// Asked: after a tap on Paste, which Safari and Firefox need (they show their own Paste button, and have no
// permission to grant). Not asked: on coming back to the app, where only Chromium (a permission, asked once) and
// the native app (iOS asks each time) can read; elsewhere this gives "" without trying.
export async function readClipboard(asked: boolean): Promise<string> {
	if (Capacitor.isNativePlatform()) {
		const { type, value } = await Clipboard.read();
		return type.startsWith("text") ? value : "";
	}
	if (typeof navigator.clipboard?.readText !== "function") return "";
	if (!asked) {
		try {
			const { state } = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
			if (state === "denied") return "";
		} catch {
			return "";
		}
	}
	return navigator.clipboard.readText();
}

export function canPaste(): boolean {
	return Capacitor.isNativePlatform() || typeof navigator.clipboard?.readText === "function";
}

const tried = new Set<string>();

// While a code screen is open: when people come back to the app (from their email, most likely), takes a code they
// copied and hands it over once. Where reading is refused or not possible, nothing happens and they tap Paste.
export function useEmailedCodeFromClipboard(active: boolean, onCode: (code: string) => void) {
	const latest = useRef(onCode);
	latest.current = onCode;

	useEffect(() => {
		if (!active) return;
		let away = document.visibilityState === "hidden" || !document.hasFocus();
		let reading = false;

		async function check() {
			if (!away || reading || document.visibilityState === "hidden") return;
			away = false;
			reading = true;
			try {
				const code = emailedCodeIn(await readClipboard(false));
				if (code && !tried.has(code)) {
					tried.add(code);
					latest.current(code);
				}
			} catch {
				// Refused or unsupported.
			} finally {
				reading = false;
			}
		}

		function leave() {
			away = true;
		}

		function onVisibility() {
			if (document.visibilityState === "hidden") leave();
			else void check();
		}

		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("blur", leave);
		window.addEventListener("focus", check);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("blur", leave);
			window.removeEventListener("focus", check);
		};
	}, [active]);
}
