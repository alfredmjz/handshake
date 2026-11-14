-- Pull row builders: each synced table's pull_changes() JSON is described once, in its own function, and
-- pull_changes() is rebuilt from them. The JSON is the same as 016's, key for key. The device reads it in
-- src/lib/sync/wire.ts; tests/fixtures/pull-keys.ts pins the key set per table on both sides
-- (supabase/tests/pull_keys.test.sql here, tests/lib/sync/pull-keys.test.ts on the device). Safe to re-run.
--
-- The builders live in public, not private: pull_changes() runs as the caller (SECURITY INVOKER) so row level
-- security picks the rows, and the caller has no USAGE on private. Each one only formats a row the caller
-- could already SELECT, and runs as the caller too, so a share's parts are still filtered by their policies.

CREATE OR REPLACE FUNCTION public.pull_group_row(g public.groups)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'id', g.id,
        'name', g.name,
        'note', g.note,
        'cover_color', g.cover_color,
        'cover_sticker', g.cover_sticker,
        'base_currency', g.base_currency,
        'join_code', g.join_code,
        'created_by', g.created_by,
        'created_at', g.created_at,
        'deleted_at', g.deleted_at,
        'completed_at', g.completed_at,
        'completed_by_member_id', g.completed_by_member_id,
        'row_version', g.row_version
    );
$$;

CREATE OR REPLACE FUNCTION public.pull_member_row(gm public.group_members)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'id', gm.id,
        'group_id', gm.group_id,
        'user_id', gm.user_id,
        'display_name', gm.display_name,
        'role', gm.role,
        'joined_at', gm.joined_at,
        'deleted_at', gm.deleted_at,
        'row_version', gm.row_version
    );
$$;

-- owed_to: payer member id -> cents, from the share's parts.
CREATE OR REPLACE FUNCTION public.pull_share_row(s public.ledger_shares)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'member_id', s.member_id,
        'paid_cents', s.paid_cents,
        'owed_cents', s.owed_cents,
        'owed_to', COALESCE((
            SELECT jsonb_object_agg(p.payer_member_id, p.owed_cents)
            FROM public.ledger_share_parts p
            WHERE p.entry_id = s.entry_id AND p.member_id = s.member_id
        ), '{}'::JSONB)
    );
$$;

-- A bill or payment with its shares, sorted by member id.
CREATE OR REPLACE FUNCTION public.pull_entry_row(e public.ledger_entries)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'id', e.id,
        'group_id', e.group_id,
        'kind', e.kind,
        'description', e.description,
        'amount_cents', e.amount_cents,
        'items', e.items,
        'entry_date', e.entry_date,
        'notes', e.notes,
        'category', e.category,
        'payment_status', e.payment_status,
        'payer_confirmed_at', e.payer_confirmed_at,
        'receiver_confirmed_at', e.receiver_confirmed_at,
        'confirmed_at', e.confirmed_at,
        'closed_at', e.closed_at,
        'close_note', e.close_note,
        'created_by_member_id', e.created_by_member_id,
        'updated_by_member_id', e.updated_by_member_id,
        'created_at', e.created_at,
        'updated_at', e.updated_at,
        'deleted_at', e.deleted_at,
        'row_version', e.row_version,
        'shares', COALESCE((
            SELECT jsonb_agg(public.pull_share_row(s) ORDER BY s.member_id)
            FROM public.ledger_shares s
            WHERE s.entry_id = e.id
        ), '[]'::JSONB)
    );
$$;

CREATE OR REPLACE FUNCTION public.pull_conflict_row(c public.entry_conflicts)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'id', c.id,
        'group_id', c.group_id,
        'entry_id', c.entry_id,
        'base_version', c.base_version,
        'base', c.base,
        'proposed', c.proposed,
        'proposed_by_member_id', c.proposed_by_member_id,
        'created_at', c.created_at,
        'resolved_at', c.resolved_at,
        'resolved_by_member_id', c.resolved_by_member_id,
        'resolution', c.resolution,
        'row_version', c.row_version
    );
$$;

-- Takes the columns rather than the row: devices may not read an invite's token_hash, so the whole row can't be
-- passed.
CREATE OR REPLACE FUNCTION public.pull_invite_row(
    p_id UUID, p_group_id UUID, p_claim_member_id UUID, p_created_by UUID,
    p_created_at TIMESTAMPTZ, p_expires_at TIMESTAMPTZ, p_revoked_at TIMESTAMPTZ, p_row_version BIGINT
)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'id', p_id,
        'group_id', p_group_id,
        'claim_member_id', p_claim_member_id,
        'created_by', p_created_by,
        'created_at', p_created_at,
        'expires_at', p_expires_at,
        'revoked_at', p_revoked_at,
        'row_version', p_row_version
    );
$$;

CREATE OR REPLACE FUNCTION public.pull_nudge_row(n public.nudges)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'id', n.id,
        'group_id', n.group_id,
        'from_member_id', n.from_member_id,
        'to_member_id', n.to_member_id,
        'amount_cents', n.amount_cents,
        'created_at', n.created_at,
        'row_version', n.row_version
    );
$$;

CREATE OR REPLACE FUNCTION public.pull_guest_code_row(gc public.guest_codes)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'member_id', gc.member_id,
        'group_id', gc.group_id,
        'code', gc.code,
        'created_at', gc.created_at,
        'deleted_at', gc.deleted_at,
        'row_version', gc.row_version
    );
$$;

-- As in 016, built from the row builders.
CREATE OR REPLACE FUNCTION public.pull_changes(p_cursors JSONB DEFAULT '{}'::JSONB)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
    WITH mine AS (
        SELECT g.id, g.head_version, COALESCE((p_cursors->>(g.id::TEXT))::BIGINT, 0) AS since
        FROM public.groups g
        WHERE public.is_group_member(g.id)
    )
    SELECT jsonb_build_object(
        'group_ids', COALESCE((SELECT jsonb_agg(m.id) FROM mine m), '[]'::JSONB),
        'moved_away', COALESCE((
            SELECT jsonb_agg(DISTINCT h.group_id)
            FROM public.guest_handoffs h
            WHERE h.from_user_id = (SELECT auth.uid()) AND NOT EXISTS (SELECT 1 FROM mine m WHERE m.id = h.group_id)
        ), '[]'::JSONB),
        'changes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'group_id', m.id,
                'version', m.head_version,
                'groups', COALESCE((
                    SELECT jsonb_agg(public.pull_group_row(g))
                    FROM public.groups g
                    WHERE g.id = m.id AND g.row_version > m.since
                ), '[]'::JSONB),
                'members', COALESCE((
                    SELECT jsonb_agg(public.pull_member_row(gm))
                    FROM public.group_members gm
                    WHERE gm.group_id = m.id AND gm.row_version > m.since
                ), '[]'::JSONB),
                'entries', COALESCE((
                    SELECT jsonb_agg(public.pull_entry_row(e))
                    FROM public.ledger_entries e
                    WHERE e.group_id = m.id AND e.row_version > m.since
                ), '[]'::JSONB),
                'conflicts', COALESCE((
                    SELECT jsonb_agg(public.pull_conflict_row(c))
                    FROM public.entry_conflicts c
                    WHERE c.group_id = m.id AND c.row_version > m.since
                ), '[]'::JSONB),
                'invites', COALESCE((
                    SELECT jsonb_agg(public.pull_invite_row(
                        i.id, i.group_id, i.claim_member_id, i.created_by, i.created_at, i.expires_at, i.revoked_at, i.row_version
                    ))
                    FROM public.group_invites i
                    WHERE i.group_id = m.id AND i.row_version > m.since
                ), '[]'::JSONB),
                'nudges', COALESCE((
                    SELECT jsonb_agg(public.pull_nudge_row(n))
                    FROM public.nudges n
                    WHERE n.group_id = m.id AND n.row_version > m.since
                ), '[]'::JSONB),
                'guest_codes', COALESCE((
                    SELECT jsonb_agg(public.pull_guest_code_row(gc))
                    FROM public.guest_codes gc
                    WHERE gc.group_id = m.id AND gc.row_version > m.since
                ), '[]'::JSONB)
            ))
            FROM mine m
            WHERE m.head_version > m.since
        ), '[]'::JSONB)
    );
$$;

REVOKE EXECUTE ON FUNCTION public.pull_group_row(public.groups) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pull_member_row(public.group_members) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pull_share_row(public.ledger_shares) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pull_entry_row(public.ledger_entries) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pull_conflict_row(public.entry_conflicts) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pull_invite_row(UUID, UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BIGINT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pull_nudge_row(public.nudges) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pull_guest_code_row(public.guest_codes) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pull_changes(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pull_group_row(public.groups) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_member_row(public.group_members) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_share_row(public.ledger_shares) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_entry_row(public.ledger_entries) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_conflict_row(public.entry_conflicts) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_invite_row(UUID, UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_nudge_row(public.nudges) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_guest_code_row(public.guest_codes) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pull_changes(JSONB) TO authenticated;
