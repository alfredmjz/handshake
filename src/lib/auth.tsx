import { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import { clearLocalData, db } from "@/lib/local-db";
import { supabase } from "@/lib/supabase";
import { deleteAccount, upgradeGuest } from "@/lib/sync/supabase-transport";

// isAnonymous: a guest (Supabase anonymous sign-in) who hasn't added an email yet.
export type CurrentUser = { id: string; email: string; isAnonymous: boolean };
export type AuthState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; user: CurrentUser };

const KNOWN_USER_KEY = "handshake.user";

// Access tokens expire hourly and can't be refreshed offline, so a missing session is not proof of
// being signed out. The app stays signed in as the last known user until Supabase reports SIGNED_OUT.
function readKnownUser(): CurrentUser | null {
	try {
		const raw = localStorage.getItem(KNOWN_USER_KEY);
		if (!raw) return null;
		const known = JSON.parse(raw) as Partial<CurrentUser> | null;
		if (typeof known?.id !== "string") return null;
		// Stored before guests existed, so without isAnonymous.
		return {
			id: known.id,
			email: typeof known.email === "string" ? known.email : "",
			isAnonymous: known.isAnonymous === true,
		};
	} catch {
		return null;
	}
}

function writeKnownUser(user: CurrentUser | null) {
	try {
		if (user) localStorage.setItem(KNOWN_USER_KEY, JSON.stringify(user));
		else localStorage.removeItem(KNOWN_USER_KEY);
	} catch {
		// Storage can be unavailable (private mode); the session itself still works.
	}
}

function toUser(session: Session): CurrentUser {
	return { id: session.user.id, email: session.user.email ?? "", isAnonymous: session.user.is_anonymous === true };
}

const sameUser = (a: CurrentUser, b: CurrentUser) =>
	a.id === b.id && a.email === b.email && a.isAnonymous === b.isAnonymous;

export function useAuthState(): AuthState {
	const [state, setState] = useState<AuthState>(() => {
		const known = readKnownUser();
		return known ? { status: "signed-in", user: known } : { status: "loading" };
	});

	useEffect(() => {
		const { data } = supabase.auth.onAuthStateChange((event, session) => {
			if (session) {
				const user = toUser(session);
				writeKnownUser(user);
				setState((prev) =>
					prev.status === "signed-in" && sameUser(prev.user, user) ? prev : { status: "signed-in", user }
				);
				return;
			}
			if (event === "SIGNED_OUT" || !readKnownUser()) {
				writeKnownUser(null);
				setState({ status: "signed-out" });
			}
		});
		return () => data.subscription.unsubscribe();
	}, []);

	return state;
}

// Signs in as a guest: a real but anonymous account, so sync works as for everyone else.
export async function signInAsGuest(): Promise<void> {
	const { error } = await supabase.auth.signInAnonymously();
	if (error) throw error;
}

// upgrade_guest() reads is_anonymous from the access token, so it needs one issued after the email change.
async function upgradeWithFreshToken() {
	const { error } = await supabase.auth.refreshSession();
	if (error) throw error;
	await upgradeGuest();
}

// "Keep my data", step 1: adds the email to the guest's account. Normally that sends a 6-digit code to it
// ("code-sent"). Where email confirmations are off (the local stack), the email is set at once, so this
// finishes the upgrade itself ("done").
export async function startKeepMyData(email: string): Promise<"code-sent" | "done"> {
	const { data, error } = await supabase.auth.updateUser({ email: email.trim() });
	if (error) throw error;
	if (data.user.new_email || data.user.is_anonymous) return "code-sent";
	await upgradeWithFreshToken();
	return "done";
}

// Step 2: confirms the code, then turns the guest's rows into member rows. The user id stays the same.
export async function finishKeepMyData(email: string, code: string): Promise<void> {
	const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email_change" });
	if (error) throw error;
	await upgradeWithFreshToken();
}

async function endLocally() {
	writeKnownUser(null);
	await clearLocalData();
	await supabase.auth.signOut({ scope: "local" });
}

// Online only. Afterwards nothing of this account is left on the device.
export async function deleteMyAccount(): Promise<void> {
	await deleteAccount();
	await endLocally();
}

const ENDED_KEY = "handshake.ended";

// Completing a group deletes its guests' logins. Until its token expires, a deleted login still syncs
// (and sees nothing), so ask the auth server whether the account is still there; if not, sign out here.
export async function endIfAccountGone(user: CurrentUser): Promise<boolean> {
	if (!navigator.onLine) return false;
	const { error } = await supabase.auth.getUser();
	if (!error) return false;
	const gone =
		error.code === "user_not_found" || error.code === "session_not_found" || /does not exist/i.test(error.message);
	if (!gone) return false;
	try {
		sessionStorage.setItem(ENDED_KEY, user.isAnonymous ? "guest" : "account");
	} catch {
		// Without storage the Welcome screen just doesn't explain why.
	}
	await endLocally();
	return true;
}

// Why the last session ended on its own, shown once on the Welcome screen.
export function takeEndedNotice(): string | null {
	try {
		const reason = sessionStorage.getItem(ENDED_KEY);
		sessionStorage.removeItem(ENDED_KEY);
		if (reason === "guest") return "Your guest access ended when the group was completed.";
		if (reason === "account") return "This account no longer exists on the server.";
	} catch {
		// Storage unavailable: nothing to show.
	}
	return null;
}

// Returns false when the user keeps their unsynced changes instead.
export async function signOut(): Promise<boolean> {
	const waiting = await db.outbox.count();
	if (
		waiting > 0 &&
		!window.confirm(
			`${waiting} ${waiting === 1 ? "change hasn't" : "changes haven't"} synced yet. Signing out deletes ${waiting === 1 ? "it" : "them"} from this device. Sign out anyway?`
		)
	) {
		return false;
	}
	await endLocally();
	return true;
}

export function defaultDisplayName(email: string): string {
	return email.split("@")[0] || "Me";
}

const CurrentUserContext = createContext<CurrentUser | null>(null);

export const CurrentUserProvider = CurrentUserContext.Provider;

export function useCurrentUser(): CurrentUser {
	const user = useContext(CurrentUserContext);
	if (!user) throw new Error("useCurrentUser must be used inside a signed-in page");
	return user;
}
