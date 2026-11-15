import { useEffect, useState } from "react";

// The auth server sends one sign-in email a minute per address (config.toml max_frequency, and the hosted
// project's minimum interval between emails).
export const RESEND_AFTER_MS = 60_000;

// Rounded up, so the last second reads 0:01, not 0:00.
export function secondsUntilResend(sentAt: number | null, now: number): number {
	if (sentAt === null) return 0;
	return Math.max(0, Math.ceil((sentAt + RESEND_AFTER_MS - now) / 1000));
}

export function formatCountdown(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Ticks once a second until another code can be sent. Counted from the clock, so a backgrounded tab is right on return.
export function useSecondsUntilResend(sentAt: number | null): number {
	const [now, setNow] = useState(Date.now);

	useEffect(() => {
		if (sentAt === null) return;
		setNow(Date.now());
		const timer = window.setInterval(() => {
			const time = Date.now();
			setNow(time);
			if (secondsUntilResend(sentAt, time) === 0) window.clearInterval(timer);
		}, 1000);
		return () => window.clearInterval(timer);
	}, [sentAt]);

	return secondsUntilResend(sentAt, now);
}
