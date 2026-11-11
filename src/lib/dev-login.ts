import { signInAsGuest } from "@/lib/auth";
import { db } from "@/lib/local-db";
import { supabase } from "@/lib/supabase";

// Test accounts on the local Supabase only, so a developer can skip the emailed code and switch between the
// owner of a group, someone who gets paid back, and a guest. Never reaches a build: callers check
// devLoginAvailable(), which is false outside `bun run dev` and for any non-local server.
export type TestAccount = "owner" | "payee" | "guest";

export const TEST_ACCOUNTS: { id: TestAccount; label: string; email?: string }[] = [
	{ id: "owner", label: "Owner", email: "owner@handshake.test" },
	{ id: "payee", label: "Payee", email: "payee@handshake.test" },
	{ id: "guest", label: "Guest" },
];

const PASSWORD = "handshake-local-dev";
// A guest can't sign back in, so the test guest's session is kept here between switches.
const GUEST_SESSION = "handshake.dev.guest-session";

export function devLoginAvailable(): boolean {
	if (!import.meta.env.DEV) return false;
	const host = new URL(import.meta.env.VITE_SUPABASE_URL ?? "http://invalid").hostname;
	return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

type SavedSession = { userId: string; access_token: string; refresh_token: string };

function savedGuest(): SavedSession | null {
	try {
		return JSON.parse(localStorage.getItem(GUEST_SESSION) ?? "null") as SavedSession | null;
	} catch {
		return null;
	}
}

// Which test account is signed in now, if any.
export async function currentTestAccount(): Promise<TestAccount | null> {
	const { data } = await supabase.auth.getSession();
	const user = data.session?.user;
	if (!user) return null;
	if (user.is_anonymous) return savedGuest()?.userId === user.id ? "guest" : null;
	return TEST_ACCOUNTS.find((a) => a.email === user.email)?.id ?? null;
}

async function keepGuestSession() {
	const { data } = await supabase.auth.getSession();
	const session = data.session;
	if (!session?.user.is_anonymous) return;
	localStorage.setItem(
		GUEST_SESSION,
		JSON.stringify({
			userId: session.user.id,
			access_token: session.access_token,
			refresh_token: session.refresh_token,
		} satisfies SavedSession)
	);
}

async function signInAs(account: TestAccount): Promise<void> {
	if (account === "guest") {
		const saved = savedGuest();
		if (saved) {
			const restored = await supabase.auth.setSession(saved);
			if (!restored.error) return;
		}
		await signInAsGuest();
		await keepGuestSession();
		return;
	}
	const email = TEST_ACCOUNTS.find((a) => a.id === account)!.email!;
	const signIn = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
	if (!signIn.error) return;
	// The first time, make the account; the local server signs new accounts in at once.
	const signUp = await supabase.auth.signUp({ email, password: PASSWORD });
	if (signUp.error) throw signUp.error;
	if (!signUp.data.session)
		throw new Error("The local server wants the email confirmed; turn off enable_confirmations.");
}

// Signs straight in as the chosen test account. There is no sign-out in between: signing out revokes the
// session on the server, which would lose the test guest for good. The layout clears the last account's
// rows from this device when the user changes. Returns false when unsynced changes made the person stay.
export async function switchToTestAccount(account: TestAccount): Promise<boolean> {
	const { data } = await supabase.auth.getSession();
	if (data.session) {
		const waiting = await db.outbox.count();
		if (
			waiting > 0 &&
			!window.confirm(`${waiting} unsynced ${waiting === 1 ? "change" : "changes"} will be lost. Switch anyway?`)
		)
			return false;
		if ((await currentTestAccount()) === "guest") await keepGuestSession();
	}
	await signInAs(account);
	if (account === "guest") await keepGuestSession();
	return true;
}
