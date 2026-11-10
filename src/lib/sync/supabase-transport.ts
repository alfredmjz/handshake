import type { PostgrestError } from "@supabase/supabase-js";

import { supabase } from "@/lib/supabase";
import type { SyncTransport } from "@/lib/sync/engine";
import type { PushResult } from "@/lib/sync/types";
import { toPullResult, type RawPull } from "@/lib/sync/wire";

// code is the SQLSTATE or HS code the database raised ("HS403", "22P02", …), or "network" when the request
// never got an answer from the database. Every function but previewInvite needs a session: signed out, the
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

export type InvitePreview = {
	groupId: string;
	groupName: string;
	// Null when the link's maker has deleted their account.
	invitedBy: string | null;
	// The link's name-only person while they can still be claimed.
	claimMemberId: string | null;
	unclaimed: { memberId: string; displayName: string }[];
	alreadyMember: boolean;
};

// Works signed out. HS404 when the link is unknown, revoked, expired, or its group deleted or completed.
export function previewInvite(token: string): Promise<InvitePreview> {
	return call("preview_invite", { p_token: token });
}

// Returns the group id; then requestSync() so the group arrives. HS404 as previewInvite;
// HS422 when the picked person isn't in the group or has already been claimed; 22P02 for a malformed id;
// 23514 for a display name over 60 characters.
export function joinGroup(input: { token: string; claimMemberId?: string; displayName?: string }): Promise<string> {
	return call("join_group", {
		p_token: input.token,
		p_claim_member_id: input.claimMemberId ?? null,
		p_display_name: input.displayName ?? null,
	});
}

// After a guest's email is confirmed. HS403 while the account is still anonymous.
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
