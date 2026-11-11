import type { PostgrestError } from "@supabase/supabase-js";

import { supabase } from "@/lib/supabase";
import type { SyncTransport } from "@/lib/sync/engine";
import type { PushResult } from "@/lib/sync/types";
import { toPullResult, type RawPull } from "@/lib/sync/wire";

// code is the SQLSTATE or HS code the database raised ("HS403", "22P02", …), or "network" when the request
// never got an answer from the database. Every function but previewGroup needs a session: signed out, the
// call is refused with 42501 (no EXECUTE for anon) before the function's own 28000 check could run.
export class TransportError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "TransportError";
		this.code = code;
	}
}

function fail(error: PostgrestError): never {
	throw new TransportError(error.code || "network", error.message);
}

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
	const { data, error } = await supabase.rpc(fn, args);
	if (error) fail(error);
	return data as T;
}

// The only place the app talks to the server about data. Moving off Supabase means replacing this file
// and the SQL functions it calls.
export const supabaseTransport: SyncTransport = {
	push: (mutations) => call<PushResult>("push_changes", { p_mutations: mutations }),
	pull: async (cursors) => toPullResult(await call<RawPull>("pull_changes", { p_cursors: cursors })),
};

export type GroupPreview = {
	groupId: string;
	groupName: string;
	// Null only if the group has no active owner.
	ownerName: string | null;
	// Name-only people anyone may pick, by name.
	unclaimed: { memberId: string; displayName: string }[];
	// Guests with a personal code, by name: "I'm already in this group".
	returning: { memberId: string; displayName: string }[];
	alreadyMember: boolean;
};

// Works signed out. The code may be typed in any case, with or without its dash. HS404 "This code doesn't
// work" when it is unknown, was reset, or its group is deleted or completed.
export function previewGroup(code: string): Promise<GroupPreview> {
	return call("preview_group", { p_code: code });
}

// Returns the group id; then requestSync() so the group arrives. Does nothing if already a member.
// - New name: { code, displayName } (blank falls back to the profile name). HS409 "<name> is already in this
//   group"; 23514 for a name over 60 characters.
// - A name-only person: { code, claimMemberId }. HS422 "That person is not in this group" or "Someone has
//   already joined as that person".
// - Coming back: { code, claimMemberId, personalCode } (any case, dash ignored). HS422 "That code doesn't
//   match", "Sign in with your email to get back in" (that name has an email), "That person is not in this
//   group".
// HS404 as previewGroup; 22P02 for a malformed claimMemberId. Guests (anonymous) join as guests.
export function joinWithCode(input: {
	code: string;
	claimMemberId?: string;
	displayName?: string;
	personalCode?: string;
}): Promise<string> {
	return call("join_with_code", {
		p_code: input.code,
		p_claim_member_id: input.claimMemberId ?? null,
		p_display_name: input.displayName ?? null,
		p_personal_code: input.personalCode ?? null,
	});
}

// After a guest's email is confirmed. HS403 while the account is still anonymous. Their personal codes go.
export async function upgradeGuest(): Promise<void> {
	await call("upgrade_guest");
}

export type NewApiToken = { id: string; token: string; name: string; createdAt: string };
export type ApiToken = { id: string; name: string; scope: "read"; createdAt: string; lastUsedAt: string | null };

// The token is returned this once. HS403 for guests; HS422 for a name that isn't 1–60
// characters or an 11th live token.
export function createApiToken(name: string): Promise<NewApiToken> {
	return call("create_api_token", { p_name: name });
}

// Live tokens, newest first. HS403 for guests.
export function listApiTokens(): Promise<ApiToken[]> {
	return call("list_api_tokens");
}

// Unknown or already revoked ids do nothing. HS403 for guests; 22P02 for a malformed id.
export async function revokeApiToken(id: string): Promise<void> {
	await call("revoke_api_token", { p_id: id });
}

// Leaves the person's history behind as a name-only person and removes their login.
export async function deleteAccount(): Promise<void> {
	await call("delete_account");
}
