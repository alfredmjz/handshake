import { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import { clearLocalData, db } from "@/lib/local-db";
import { supabase } from "@/lib/supabase";

export type CurrentUser = { id: string; email: string };
export type AuthState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; user: CurrentUser };

const KNOWN_USER_KEY = "handshake.user";

// Access tokens expire hourly and can't be refreshed offline, so a missing session is not proof of
// being signed out. The app stays signed in as the last known user until Supabase reports SIGNED_OUT.
function readKnownUser(): CurrentUser | null {
	try {
		const raw = localStorage.getItem(KNOWN_USER_KEY);
		return raw ? (JSON.parse(raw) as CurrentUser) : null;
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
	return { id: session.user.id, email: session.user.email ?? "" };
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
					prev.status === "signed-in" && prev.user.id === user.id ? prev : { status: "signed-in", user }
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
