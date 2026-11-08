import { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import { clearLocalData, db } from "@/lib/local-db";
import { supabase } from "@/lib/supabase";
import { requestSync } from "@/lib/sync/controller";
import { deleteAccount as deleteAccountOnServer, upgradeGuest } from "@/lib/sync/supabase-transport";

// A guest is an anonymous Supabase user (spec decision 9).
export type CurrentUser = { id: string; email: string; isAnonymous: boolean };
export type AuthState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; user: CurrentUser };

const KNOWN_USER_KEY = "handshake.user";

// Access tokens expire hourly and can't be refreshed offline, so a missing session is not proof of
// being signed out. The app stays signed in as the last known user until Supabase reports SIGNED_OUT.
function readKnownUser(): CurrentUser | null {
	try {
		const raw = localStorage.getItem(KNOWN_USER_KEY);
		if (!raw) return null;
		const user = JSON.parse(raw) as Partial<CurrentUser> & { id: string; email: string };
		return { ...user, isAnonymous: user.isAnonymous ?? false };
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
	return { id: session.user.id, email: session.user.email ?? "", isAnonymous: session.user.is_anonymous ?? false };
}

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
					prev.status === "signed-in" && prev.user.id === user.id && prev.user.isAnonymous === user.isAnonymous
						? prev
						: { status: "signed-in", user }
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
	writeKnownUser(null);
	await clearLocalData();
	await supabase.auth.signOut({ scope: "local" });
	return true;
}

// Continue as guest: an anonymous sign-in, so sync and permissions work as for anyone else.
export async function signInAsGuest(): Promise<void> {
	const { error } = await supabase.auth.signInAnonymously();
	if (error) throw new Error(error.message);
}

// "Keep my data", step 1: add an email to the guest's account; Supabase sends a 6-digit code.
export async function startKeepMyData(email: string): Promise<void> {
	const { error } = await supabase.auth.updateUser({ email: email.trim() });
	if (error) throw new Error(error.message);
}

// Step 2: the code confirms the email, the same user id stays, and their guest rows become member rows.
export async function finishKeepMyData(email: string, code: string): Promise<void> {
	const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email_change" });
	if (error) throw new Error(error.message);
	await supabase.auth.refreshSession();
	await upgradeGuest();
	requestSync();
}

// Online only (spec decision 19). Afterwards nothing of this account is left on the device.
export async function deleteAccount(): Promise<void> {
	await deleteAccountOnServer();
	writeKnownUser(null);
	await clearLocalData();
	await supabase.auth.signOut({ scope: "local" });
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
