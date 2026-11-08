import { supabase } from "@/lib/supabase";
import type { SyncTransport } from "@/lib/sync/engine";
import type { PushResult } from "@/lib/sync/types";
import { toPullResult, type RawPull } from "@/lib/sync/wire";

// The only place the app talks to the server about data. Moving off Supabase means replacing this file
// and the SQL functions it calls.

// code is the SQLSTATE (HS403, HS404, HS422, 28000, …), or "network" when the server wasn't reached.
export class TransportError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = "TransportError";
	}
}

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
	const { data, error } = await supabase.rpc(fn, args);
	if (error) throw new TransportError(error.code || "network", error.message);
	return data as T;
}

export const supabaseTransport: SyncTransport = {
	push: (mutations) => call<PushResult>("push_changes", { p_mutations: mutations }),
	pull: async (cursors) => toPullResult(await call<RawPull>("pull_changes", { p_cursors: cursors })),
};

// ---------------------------------------------------------------------------
// Online-only functions (spec "Online-only functions"). Screens say "needs a connection" when offline,
// and call requestSync() after joinGroup and upgradeGuest so the group arrives through the normal pull.
// ---------------------------------------------------------------------------

export type InvitePreview = {
	groupId: string;
	groupName: string;
	// Null when the link's maker has deleted their account.
	invitedBy: string | null;
	claimMemberId: string | null;
	unclaimed: { memberId: string; displayName: string }[];
	alreadyMember: boolean;
};

export type ApiToken = { id: string; name: string; scope: "read"; createdAt: string; lastUsedAt: string | null };
export type NewApiToken = { id: string; token: string; name: string; createdAt: string };

// Works signed out too. HS404 when the link is unknown, expired, revoked, or its group is deleted or completed.
export function previewInvite(token: string): Promise<InvitePreview> {
	return call("preview_invite", { p_token: token });
}

// Returns the group id. claimMemberId picks a name-only person to become; displayName names someone new.
export function joinGroup(token: string, claimMemberId: string | null, displayName: string | null): Promise<string> {
	return call("join_group", { p_token: token, p_claim_member_id: claimMemberId, p_display_name: displayName });
}

// After a guest has added an email: their guest rows become member rows.
export async function upgradeGuest(): Promise<void> {
	await call("upgrade_guest");
}

// The token is in the result this once; Handshake keeps only its hash.
export function createApiToken(name: string): Promise<NewApiToken> {
	return call("create_api_token", { p_name: name });
}

export function listApiTokens(): Promise<ApiToken[]> {
	return call("list_api_tokens");
}

export async function revokeApiToken(id: string): Promise<void> {
	await call("revoke_api_token", { p_id: id });
}

// Everything in spec decision 19, in one transaction on the server. The caller then clears the device.
export async function deleteAccount(): Promise<void> {
	await call("delete_account");
}
