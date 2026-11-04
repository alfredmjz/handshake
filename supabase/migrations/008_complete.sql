-- Migration: 008_complete
-- Description: Completing a group. group.complete (owner) makes the group read-only and, in the same
-- transaction, takes away the access of every guest who never added an email: their member row becomes
-- a name-only non-member, so entries and balances still add up, and a guest login left in no other
-- group is deleted. group.reopen (owner) makes the group editable again; deleted logins don't come back.

ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS completed_by_member_id UUID REFERENCES public.group_members(id);

-- =============================================================================
-- Completed groups refuse every change but group.reopen and group.delete
-- =============================================================================

CREATE OR REPLACE FUNCTION private.require_member(
    p_user UUID,
    p_group_id UUID,
    p_roles TEXT[],
    p_allow_completed BOOLEAN DEFAULT FALSE
)
RETURNS public.group_members
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_member public.group_members;
BEGIN
    PERFORM 1 FROM public.groups WHERE id = p_group_id FOR NO KEY UPDATE;
    v_member := private.caller_member(p_user, p_group_id);

    IF v_member.id IS NULL THEN
        RAISE EXCEPTION 'You are not a member of this group' USING ERRCODE = 'HS403';
    END IF;
    IF EXISTS (SELECT 1 FROM public.groups WHERE id = p_group_id AND deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'This group was deleted' USING ERRCODE = 'HS403';
    END IF;
    IF NOT p_allow_completed AND EXISTS (SELECT 1 FROM public.groups WHERE id = p_group_id AND completed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'This group is completed' USING ERRCODE = 'HS403';
    END IF;
    IF NOT v_member.role = ANY (p_roles) THEN
        RAISE EXCEPTION '%', CASE WHEN p_roles = ARRAY['owner'] THEN 'Only the group''s owner can do this'
            ELSE 'Guests can''t do this' END
            USING ERRCODE = 'HS403';
    END IF;

    RETURN v_member;
END;
$$;

-- A completed group's links stop working until it is reopened.
CREATE OR REPLACE FUNCTION private.find_invite(p_token TEXT)
RETURNS public.group_invites
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
    v_invite public.group_invites;
BEGIN
    SELECT i.* INTO v_invite
    FROM public.group_invites i
    JOIN public.groups g ON g.id = i.group_id
    WHERE i.token_hash = private.hash_token(p_token)
        AND i.revoked_at IS NULL
        AND i.expires_at > NOW()
        AND g.deleted_at IS NULL
        AND g.completed_at IS NULL;

    IF v_invite.id IS NULL THEN
        RAISE EXCEPTION 'This invite link doesn''t work any more' USING ERRCODE = 'HS404';
    END IF;
    RETURN v_invite;
END;
$$;

-- =============================================================================
-- Changes
-- =============================================================================

CREATE OR REPLACE FUNCTION private.apply_group_complete(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_version BIGINT;
    v_guest UUID;
BEGIN
    v_me := private.require_member(p_user, v_group_id, ARRAY['owner']);

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups
    SET completed_at = NOW(), completed_by_member_id = v_me.id, updated_at = NOW(), row_version = v_version
    WHERE id = v_group_id;

    FOR v_guest IN
        UPDATE public.group_members gm
        SET user_id = NULL, role = 'member', joined_at = NULL, updated_at = NOW(), row_version = v_version
        FROM auth.users u
        WHERE gm.group_id = v_group_id AND gm.role = 'guest' AND u.id = gm.user_id AND u.is_anonymous
        RETURNING u.id
    LOOP
        -- Deleting the user also deletes their profile and sync_mutations rows.
        DELETE FROM auth.users u
        WHERE u.id = v_guest AND u.is_anonymous AND NOT EXISTS (
            SELECT 1 FROM public.group_members gm
            JOIN public.groups g ON g.id = gm.group_id
            WHERE gm.user_id = v_guest AND gm.deleted_at IS NULL AND g.deleted_at IS NULL
        );
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.apply_group_reopen(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_version BIGINT;
BEGIN
    PERFORM private.require_member(p_user, v_group_id, ARRAY['owner'], TRUE);

    IF NOT EXISTS (SELECT 1 FROM public.groups WHERE id = v_group_id AND completed_at IS NOT NULL) THEN
        RETURN;
    END IF;

    -- Taken first: next_group_version() updates this same row.
    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups
    SET completed_at = NULL, completed_by_member_id = NULL, updated_at = NOW(), row_version = v_version
    WHERE id = v_group_id;
END;
$$;

-- =============================================================================
-- Pull: groups gain completed_at and completed_by_member_id
-- =============================================================================

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
        'changes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'group_id', m.id,
                'version', m.head_version,
                'groups', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', g.id,
                        'name', g.name,
                        'base_currency', g.base_currency,
                        'created_by', g.created_by,
                        'created_at', g.created_at,
                        'deleted_at', g.deleted_at,
                        'completed_at', g.completed_at,
                        'completed_by_member_id', g.completed_by_member_id,
                        'row_version', g.row_version
                    ))
                    FROM public.groups g
                    WHERE g.id = m.id AND g.row_version > m.since
                ), '[]'::JSONB),
                'members', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', gm.id,
                        'group_id', gm.group_id,
                        'user_id', gm.user_id,
                        'display_name', gm.display_name,
                        'role', gm.role,
                        'joined_at', gm.joined_at,
                        'deleted_at', gm.deleted_at,
                        'row_version', gm.row_version
                    ))
                    FROM public.group_members gm
                    WHERE gm.group_id = m.id AND gm.row_version > m.since
                ), '[]'::JSONB),
                'entries', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', e.id,
                        'group_id', e.group_id,
                        'kind', e.kind,
                        'description', e.description,
                        'amount_cents', e.amount_cents,
                        'items', e.items,
                        'entry_date', e.entry_date,
                        'notes', e.notes,
                        'recorded_via', e.recorded_via,
                        'created_by_member_id', e.created_by_member_id,
                        'updated_by_member_id', e.updated_by_member_id,
                        'created_at', e.created_at,
                        'updated_at', e.updated_at,
                        'deleted_at', e.deleted_at,
                        'row_version', e.row_version,
                        'shares', COALESCE((
                            SELECT jsonb_agg(jsonb_build_object(
                                'member_id', s.member_id,
                                'paid_cents', s.paid_cents,
                                'owed_cents', s.owed_cents
                            ) ORDER BY s.member_id)
                            FROM public.ledger_shares s
                            WHERE s.entry_id = e.id
                        ), '[]'::JSONB)
                    ))
                    FROM public.ledger_entries e
                    WHERE e.group_id = m.id AND e.row_version > m.since
                ), '[]'::JSONB),
                'conflicts', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
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
                    ))
                    FROM public.entry_conflicts c
                    WHERE c.group_id = m.id AND c.row_version > m.since
                ), '[]'::JSONB),
                'invites', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', i.id,
                        'group_id', i.group_id,
                        'claim_member_id', i.claim_member_id,
                        'created_by', i.created_by,
                        'created_at', i.created_at,
                        'expires_at', i.expires_at,
                        'revoked_at', i.revoked_at,
                        'row_version', i.row_version
                    ))
                    FROM public.group_invites i
                    WHERE i.group_id = m.id AND i.row_version > m.since
                ), '[]'::JSONB)
            ))
            FROM mine m
            WHERE m.head_version > m.since
        ), '[]'::JSONB)
    );
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pull_changes(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pull_changes(JSONB) TO authenticated;
