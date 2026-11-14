// The keys pull_changes() sends, per level of its JSON, sorted. Both sides are held to it:
// supabase/tests/pull_keys.test.sql (rendered by `bun run gen:pull-keys`) checks what the server builds
// (supabase/migrations/017_pull_row_builders.sql), and tests/lib/sync/pull-keys.test.ts checks that
// src/lib/sync/wire.ts reads every one of them and nothing else.

export type PullLevel =
	"pull" | "changes" | "groups" | "members" | "entries" | "shares" | "conflicts" | "invites" | "nudges" | "guest_codes";

export const PULL_KEYS: Record<PullLevel, string[]> = {
	pull: ["changes", "group_ids", "moved_away"],
	changes: ["conflicts", "entries", "group_id", "groups", "guest_codes", "invites", "members", "nudges", "version"],
	groups: [
		"base_currency",
		"completed_at",
		"completed_by_member_id",
		"cover_color",
		"cover_sticker",
		"created_at",
		"created_by",
		"deleted_at",
		"id",
		"join_code",
		"name",
		"note",
		"row_version",
	],
	members: ["deleted_at", "display_name", "group_id", "id", "joined_at", "role", "row_version", "user_id"],
	entries: [
		"amount_cents",
		"category",
		"close_note",
		"closed_at",
		"confirmed_at",
		"created_at",
		"created_by_member_id",
		"deleted_at",
		"description",
		"entry_date",
		"group_id",
		"id",
		"items",
		"kind",
		"notes",
		"payer_confirmed_at",
		"payment_status",
		"receiver_confirmed_at",
		"row_version",
		"shares",
		"updated_at",
		"updated_by_member_id",
	],
	// Each entry's shares.
	shares: ["member_id", "owed_cents", "owed_to", "paid_cents"],
	conflicts: [
		"base",
		"base_version",
		"created_at",
		"entry_id",
		"group_id",
		"id",
		"proposed",
		"proposed_by_member_id",
		"resolution",
		"resolved_at",
		"resolved_by_member_id",
		"row_version",
	],
	invites: ["claim_member_id", "created_at", "created_by", "expires_at", "group_id", "id", "revoked_at", "row_version"],
	nudges: ["amount_cents", "created_at", "from_member_id", "group_id", "id", "row_version", "to_member_id"],
	guest_codes: ["code", "created_at", "deleted_at", "group_id", "member_id", "row_version"],
};

// Sent, but not kept on the device: it shows dollars only.
export const PULL_KEYS_THE_DEVICE_IGNORES: Partial<Record<PullLevel, string[]>> = {
	groups: ["base_currency"],
};
