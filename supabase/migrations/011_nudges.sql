-- Migration: 011_nudges
-- Description: Nudges (chat-spec decision 4, shipped before chat, in-app only). The person owed reminds
-- someone who owes them, at most once per 24 hours per pair; the nudge carries the debt when it was sent.
-- Rows sync to the whole group and screens show each only to its two people. nudge.send joins the matrix
-- (owner, member, guest; not in a completed group), and pull_changes gains `nudges` per group.

-- =============================================================================
-- Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.nudges (
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    -- The person owed, who sent it.
    from_member_id UUID NOT NULL,
    -- The person who owes.
    to_member_id UUID NOT NULL,
    -- The debt when it was sent; it doesn't follow later changes.
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    row_version BIGINT NOT NULL DEFAULT 0,
    CHECK (from_member_id <> to_member_id),
    FOREIGN KEY (group_id, from_member_id) REFERENCES public.group_members (group_id, id),
    FOREIGN KEY (group_id, to_member_id) REFERENCES public.group_members (group_id, id)
);

CREATE INDEX IF NOT EXISTS nudges_version_idx ON public.nudges (group_id, row_version);
CREATE INDEX IF NOT EXISTS nudges_pair_idx ON public.nudges (from_member_id, to_member_id, created_at);

ALTER TABLE public.nudges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view their group's nudges" ON public.nudges;
CREATE POLICY "Members can view their group's nudges" ON public.nudges
    FOR SELECT TO authenticated USING (public.is_group_member(group_id));

REVOKE ALL ON public.nudges FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.nudges TO authenticated;

-- =============================================================================
-- The permission matrix gains nudge.send
-- =============================================================================

-- As in 004, plus nudge.send. private.allowed_when_completed is unchanged: nudge.send isn't in its list,
-- so a completed group refuses it.
CREATE OR REPLACE FUNCTION private.may(p_action TEXT, p_role TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT COALESCE(CASE p_action
        WHEN 'group.rename' THEN p_role = 'owner'
        WHEN 'group.delete' THEN p_role = 'owner'
        WHEN 'group.complete' THEN p_role = 'owner'
        WHEN 'group.reopen' THEN p_role = 'owner'
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

-- =============================================================================
-- Debts
-- =============================================================================

-- What p_from owes p_to right now, net of what p_to owes p_from, over the entries that count (live bills
-- and confirmed payments): summarizeGroup's pairwise debt. Zero or negative when p_from owes nothing.
CREATE OR REPLACE FUNCTION private.debt_between(p_group_id UUID, p_from UUID, p_to UUID)
RETURNS BIGINT
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT COALESCE(sum(CASE WHEN p.member_id = p_from THEN p.owed_cents ELSE -p.owed_cents END), 0)::BIGINT
    FROM public.ledger_share_parts p
    JOIN public.ledger_entries e ON e.id = p.entry_id AND private.entry_counts(e)
    WHERE p.group_id = p_group_id
        AND ((p.member_id = p_from AND p.payer_member_id = p_to) OR (p.member_id = p_to AND p.payer_member_id = p_from));
$$;

-- =============================================================================
-- nudge.send { nudgeId, groupId, toMemberId, amountCents }
-- =============================================================================

CREATE OR REPLACE FUNCTION private.apply_nudge_send(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_nudge_id UUID := (p_mutation->>'nudgeId')::UUID;
    v_me public.group_members;
    v_to public.group_members;
BEGIN
    v_me := private.require(p_user, v_group_id, 'nudge.send');

    -- A retry under a new mutation id: already stored, nothing to do.
    IF EXISTS (SELECT 1 FROM public.nudges WHERE id = v_nudge_id) THEN
        RETURN;
    END IF;

    SELECT * INTO v_to FROM public.group_members WHERE group_id = v_group_id AND id::TEXT = lower(p_mutation->>'toMemberId');
    IF v_to.id IS NULL THEN
        RAISE EXCEPTION 'That person is not in this group' USING ERRCODE = 'HS422';
    END IF;
    IF v_to.id = v_me.id THEN
        RAISE EXCEPTION 'You can''t nudge yourself' USING ERRCODE = 'HS422';
    END IF;
    IF v_to.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% left the group', v_to.display_name USING ERRCODE = 'HS422';
    END IF;
    IF NOT private.can_answer(v_to) THEN
        RAISE EXCEPTION '% hasn''t joined', v_to.display_name USING ERRCODE = 'HS422';
    END IF;
    IF private.debt_between(v_group_id, v_to.id, v_me.id) <= 0 THEN
        RAISE EXCEPTION '% doesn''t owe you anything', v_to.display_name USING ERRCODE = 'HS422';
    END IF;
    IF NOT private.is_cents(p_mutation->'amountCents', 1) THEN
        RAISE EXCEPTION 'The amount must be a whole number of cents from 1 to 10^12' USING ERRCODE = 'HS422';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.nudges n
        WHERE n.from_member_id = v_me.id AND n.to_member_id = v_to.id AND n.created_at > NOW() - INTERVAL '24 hours'
    ) THEN
        RAISE EXCEPTION 'You nudged % today', v_to.display_name USING ERRCODE = 'HS409';
    END IF;

    INSERT INTO public.nudges (id, group_id, from_member_id, to_member_id, amount_cents, row_version)
    VALUES (
        v_nudge_id, v_group_id, v_me.id, v_to.id, (p_mutation->>'amountCents')::NUMERIC::BIGINT,
        private.next_group_version(v_group_id)
    );
END;
$$;

-- =============================================================================
-- Pull: as in 010, plus nudges
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
                        'note', g.note,
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
