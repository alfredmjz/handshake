-- Cover colours: each group's book takes a colour from the colour board, shared with everyone in the group.
-- The colour is a key on the board ("h7s2": hue column 7 of 18, shade row 2 of 5), or NULL for the default the
-- devices work out (src/lib/cover-colors.ts). Anyone in the group may change it (group.recolor), but not once the
-- group is completed. Safe to re-run.

ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS cover_color TEXT;

-- A key on the board, or NULL. Refuses anything else, as recolorGroup does on the device.
CREATE OR REPLACE FUNCTION private.cover_color(p_mutation JSONB)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
    v_color TEXT := p_mutation->>'color';
BEGIN
    IF COALESCE(jsonb_typeof(p_mutation->'color'), 'null') = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_mutation->'color') <> 'string' OR v_color !~ '^h(1[0-7]|[0-9])s[0-4]$' THEN
        RAISE EXCEPTION 'That isn''t a colour on the board' USING ERRCODE = 'HS422';
    END IF;
    RETURN v_color;
END;
$$;

-- As in 012, plus group.recolor.
CREATE OR REPLACE FUNCTION private.may(p_action TEXT, p_role TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT COALESCE(CASE p_action
        WHEN 'group.rename' THEN p_role = 'owner'
        WHEN 'group.delete' THEN p_role = 'owner'
        WHEN 'group.complete' THEN p_role = 'owner'
        WHEN 'group.reopen' THEN p_role = 'owner'
        WHEN 'group.recode' THEN p_role = 'owner'
        WHEN 'group.recolor' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'member.add' THEN p_role IN ('owner', 'member')
        WHEN 'member.rename.self' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'member.rename.others' THEN p_role = 'owner'
        WHEN 'member.remove.self' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'member.remove.others' THEN p_role = 'owner'
        WHEN 'entry.create' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'entry.update' THEN p_role IN ('owner', 'member')
        WHEN 'entry.delete.own' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'entry.delete.others' THEN p_role IN ('owner', 'member')
        WHEN 'conflict.resolve' THEN p_role IN ('owner', 'member')
        WHEN 'invite.create' THEN p_role IN ('owner', 'member')
        WHEN 'invite.revoke.own' THEN p_role IN ('owner', 'member')
        WHEN 'invite.revoke.others' THEN p_role = 'owner'
        WHEN 'payment.record.own' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'payment.record.others' THEN p_role IN ('owner', 'member')
        WHEN 'payment.respond' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'payment.undo' THEN p_role IN ('owner', 'member', 'guest')
        WHEN 'nudge.send' THEN p_role IN ('owner', 'member', 'guest')
    END, FALSE);
$$;

-- Sets or clears the cover colour. Who may: anyone in the group, not in a completed group.
CREATE OR REPLACE FUNCTION private.apply_group_recolor(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_color TEXT;
    v_version BIGINT;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'group.recolor');
    v_color := private.cover_color(p_mutation);

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups SET cover_color = v_color, updated_at = NOW(), row_version = v_version WHERE id = v_group_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.cover_color(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.apply_group_recolor(UUID, JSONB) FROM PUBLIC, anon, authenticated;

-- As in 012, with each group's cover_color.
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
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', g.id,
                        'name', g.name,
                        'note', g.note, 'cover_color', g.cover_color,
                        'base_currency', g.base_currency,
                        'join_code', g.join_code,
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
                            SELECT jsonb_agg(jsonb_build_object(
                                'member_id', s.member_id,
                                'paid_cents', s.paid_cents,
                                'owed_cents', s.owed_cents,
                                'owed_to', COALESCE((
                                    SELECT jsonb_object_agg(p.payer_member_id, p.owed_cents)
                                    FROM public.ledger_share_parts p
                                    WHERE p.entry_id = s.entry_id AND p.member_id = s.member_id
                                ), '{}'::JSONB)
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
                ), '[]'::JSONB),
                'nudges', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'id', n.id,
                        'group_id', n.group_id,
                        'from_member_id', n.from_member_id,
                        'to_member_id', n.to_member_id,
                        'amount_cents', n.amount_cents,
                        'created_at', n.created_at,
                        'row_version', n.row_version
                    ))
                    FROM public.nudges n
                    WHERE n.group_id = m.id AND n.row_version > m.since
                ), '[]'::JSONB),
                'guest_codes', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'member_id', gc.member_id,
                        'group_id', gc.group_id,
                        'code', gc.code,
                        'created_at', gc.created_at,
                        'deleted_at', gc.deleted_at,
                        'row_version', gc.row_version
                    ))
                    FROM public.guest_codes gc
                    WHERE gc.group_id = m.id AND gc.row_version > m.since
                ), '[]'::JSONB)
            ))
            FROM mine m
            WHERE m.head_version > m.since
        ), '[]'::JSONB)
    );
$$;

REVOKE EXECUTE ON FUNCTION public.pull_changes(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pull_changes(JSONB) TO authenticated;
