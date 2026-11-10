-- Migration: 010_categories_notes
-- Description: A bill's category (food, drinks, stay, travel, groceries, fun, or none) and a group's
-- short note (the second line on its cover). The category is an entry field like any other: entry.create,
-- entry.update and conflict.resolve carry it, version snapshots and conflicts keep it, and the pull sends
-- it. The note is set by group.create or the new group.describe, which the matrix checks as group.rename.

-- =============================================================================
-- Columns
-- =============================================================================

ALTER TABLE public.ledger_entries ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE public.ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_category_check;
ALTER TABLE public.ledger_entries
    ADD CONSTRAINT ledger_entries_category_check
    CHECK (category IN ('food', 'drinks', 'stay', 'travel', 'groceries', 'fun'));
ALTER TABLE public.ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_payment_category_check;
ALTER TABLE public.ledger_entries
    ADD CONSTRAINT ledger_entries_payment_category_check CHECK (kind = 'expense' OR category IS NULL);

-- Stored trimmed; no note is NULL, never ''.
ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE public.groups DROP CONSTRAINT IF EXISTS groups_note_check;
ALTER TABLE public.groups
    ADD CONSTRAINT groups_note_check CHECK (note = btrim(note) AND char_length(note) BETWEEN 1 AND 120);

-- =============================================================================
-- Checks
-- =============================================================================

-- A mutation's category: missing or null is none; anything outside the list is HS422.
CREATE OR REPLACE FUNCTION private.entry_category(p_entry JSONB)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
    IF COALESCE(jsonb_typeof(p_entry->'category'), 'null') = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_entry->'category') <> 'string'
        OR p_entry->>'category' NOT IN ('food', 'drinks', 'stay', 'travel', 'groceries', 'fun') THEN
        RAISE EXCEPTION 'The category must be food, drinks, stay, travel, groceries or fun' USING ERRCODE = 'HS422';
    END IF;
    RETURN p_entry->>'category';
END;
$$;

-- A mutation's group note, as stored: trimmed, blank or missing is NULL, at most 120 characters.
CREATE OR REPLACE FUNCTION private.group_note(p_mutation JSONB)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
    v_note TEXT;
BEGIN
    IF COALESCE(jsonb_typeof(p_mutation->'note'), 'null') = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_mutation->'note') <> 'string' THEN
        RAISE EXCEPTION 'A group note must be text' USING ERRCODE = 'HS422';
    END IF;
    v_note := NULLIF(btrim(p_mutation->>'note'), '');
    IF char_length(v_note) > 120 THEN
        RAISE EXCEPTION 'A group note must be at most 120 characters' USING ERRCODE = 'HS422';
    END IF;
    RETURN v_note;
END;
$$;

-- =============================================================================
-- Snapshots carry the category (older snapshots without the key read as none)
-- =============================================================================

CREATE OR REPLACE FUNCTION private.entry_snapshot(p_entry_id UUID)
RETURNS JSONB
LANGUAGE sql SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'description', e.description,
        'amountCents', e.amount_cents,
        'entryDate', e.entry_date,
        'notes', e.notes,
        'category', e.category,
        'items', e.items,
        'shares', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'memberId', s.member_id,
                'paidCents', s.paid_cents,
                'owedCents', s.owed_cents,
                'owedTo', COALESCE((
                    SELECT jsonb_object_agg(p.payer_member_id, p.owed_cents)
                    FROM public.ledger_share_parts p
                    WHERE p.entry_id = s.entry_id AND p.member_id = s.member_id
                ), '{}'::JSONB)
            ) ORDER BY s.member_id)
            FROM public.ledger_shares s
            WHERE s.entry_id = e.id
        ), '[]'::JSONB),
        'deletedAt', e.deleted_at,
        'rowVersion', e.row_version,
        'updatedByMemberId', e.updated_by_member_id
    )
    FROM public.ledger_entries e
    WHERE e.id = p_entry_id;
$$;

-- Raises HS422 for an unknown category, so a stale change with one is rejected, not stored.
CREATE OR REPLACE FUNCTION private.entry_proposal(p_entry JSONB)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'description', btrim(p_entry->>'description'),
        'amountCents', (p_entry->>'amountCents')::NUMERIC::BIGINT,
        'entryDate', (p_entry->>'entryDate')::DATE,
        'notes', p_entry->>'notes',
        'category', private.entry_category(p_entry),
        'items', p_entry->'items',
        'shares', (
            SELECT jsonb_agg(jsonb_build_object(
                'memberId', s.member_id,
                'paidCents', s.paid_cents,
                'owedCents', s.owed_cents,
                'owedTo', s.owed_to
            ) ORDER BY s.member_id)
            FROM private.share_rows(p_entry->'shares') s
        ),
        'deletedAt', NULL
    );
$$;

-- =============================================================================
-- Writing bills: entry.create, entry.update and conflict.resolve all save through here
-- =============================================================================

CREATE OR REPLACE FUNCTION private.save_entry(
    p_entry_id UUID,
    p_group_id UUID,
    p_entry JSONB,
    p_member_id UUID,
    p_version BIGINT,
    p_is_new BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_category TEXT := private.entry_category(p_entry);
BEGIN
    IF p_is_new THEN
        INSERT INTO public.ledger_entries (
            id, group_id, kind, description, amount_cents, items, entry_date, notes, category,
            created_by_member_id, updated_by_member_id, row_version
        )
        VALUES (
            p_entry_id, p_group_id, 'expense', btrim(p_entry->>'description'),
            (p_entry->>'amountCents')::NUMERIC::BIGINT, p_entry->'items', (p_entry->>'entryDate')::DATE, p_entry->>'notes',
            v_category, p_member_id, p_member_id, p_version
        );
    ELSE
        UPDATE public.ledger_entries
        SET description = btrim(p_entry->>'description'),
            amount_cents = (p_entry->>'amountCents')::NUMERIC::BIGINT,
            items = p_entry->'items',
            entry_date = (p_entry->>'entryDate')::DATE,
            notes = p_entry->>'notes',
            category = v_category,
            updated_by_member_id = p_member_id,
            updated_at = NOW(),
            deleted_at = NULL,
            row_version = p_version
        WHERE id = p_entry_id;
    END IF;

    PERFORM private.write_shares(p_entry_id, p_group_id, p_entry->'shares');
    PERFORM private.record_entry_version(p_entry_id);
END;
$$;

-- =============================================================================
-- Payments have no category
-- =============================================================================

-- As in 005, with the category refused.
CREATE OR REPLACE FUNCTION private.apply_payment_record(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_from public.group_members;
    v_to public.group_members;
    v_amount BIGINT;
    v_other_can_answer BOOLEAN;
    v_entry_id UUID := (p_mutation->>'entryId')::UUID;
    v_version BIGINT;
BEGIN
    v_me := private.caller_member(p_user, v_group_id);
    v_me := private.require(p_user, v_group_id,
        CASE WHEN v_me.id::TEXT IN (lower(p_mutation->>'fromMemberId'), lower(p_mutation->>'toMemberId'))
            THEN 'payment.record.own' ELSE 'payment.record.others' END);

    IF COALESCE(jsonb_typeof(p_mutation->'category'), 'null') <> 'null' THEN
        RAISE EXCEPTION 'A payment has no category' USING ERRCODE = 'HS422';
    END IF;

    SELECT * INTO v_from FROM public.group_members WHERE group_id = v_group_id AND id::TEXT = lower(p_mutation->>'fromMemberId');
    SELECT * INTO v_to FROM public.group_members WHERE group_id = v_group_id AND id::TEXT = lower(p_mutation->>'toMemberId');
    IF v_from.id IS NULL OR v_to.id IS NULL THEN
        RAISE EXCEPTION 'Both sides of a payment must be in this group' USING ERRCODE = 'HS422';
    END IF;
    IF v_from.id = v_to.id THEN
        RAISE EXCEPTION 'A payment is between two different people' USING ERRCODE = 'HS422';
    END IF;
    IF v_me.id NOT IN (v_from.id, v_to.id) AND (private.can_answer(v_from) OR private.can_answer(v_to)) THEN
        RAISE EXCEPTION 'You can only record payments between two people who can''t answer them themselves' USING ERRCODE = 'HS422';
    END IF;
    IF NOT private.is_cents(p_mutation->'amountCents', 1) THEN
        RAISE EXCEPTION 'The amount must be a whole number of cents from 1 to 10^12' USING ERRCODE = 'HS422';
    END IF;
    v_amount := (p_mutation->>'amountCents')::NUMERIC::BIGINT;
    IF COALESCE(p_mutation->>'entryDate', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'The date must be YYYY-MM-DD' USING ERRCODE = 'HS422';
    END IF;
    BEGIN
        PERFORM (p_mutation->>'entryDate')::DATE;
    EXCEPTION WHEN data_exception THEN
        RAISE EXCEPTION 'The date must be a real day' USING ERRCODE = 'HS422';
    END;
    IF p_mutation->>'notes' IS NOT NULL AND (jsonb_typeof(p_mutation->'notes') <> 'string' OR char_length(p_mutation->>'notes') > 1000) THEN
        RAISE EXCEPTION 'Notes must be text of at most 1000 characters' USING ERRCODE = 'HS422';
    END IF;
    IF char_length(private.entry_description(p_mutation || '{"kind": "payment"}')) > 120 THEN
        RAISE EXCEPTION 'The description must be at most 120 characters' USING ERRCODE = 'HS422';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.ledger_entries e
        WHERE e.group_id = v_group_id AND e.payment_status = 'pending'
            AND (SELECT count(*) FROM public.ledger_shares s WHERE s.entry_id = e.id AND s.member_id IN (v_from.id, v_to.id)) = 2
    ) THEN
        RAISE EXCEPTION 'A payment between these two is already waiting for an answer' USING ERRCODE = 'HS409';
    END IF;

    v_other_can_answer := CASE
        WHEN v_me.id = v_from.id THEN private.can_answer(v_to)
        WHEN v_me.id = v_to.id THEN private.can_answer(v_from)
        ELSE FALSE
    END;
    v_version := private.next_group_version(v_group_id);

    INSERT INTO public.ledger_entries (
        id, group_id, kind, description, amount_cents, entry_date, notes,
        payment_status, payer_confirmed_at, receiver_confirmed_at, confirmed_at,
        created_by_member_id, updated_by_member_id, row_version
    )
    VALUES (
        v_entry_id, v_group_id, 'payment', private.entry_description(p_mutation || '{"kind": "payment"}'),
        v_amount, (p_mutation->>'entryDate')::DATE, p_mutation->>'notes',
        CASE WHEN v_other_can_answer THEN 'pending' ELSE 'confirmed' END,
        CASE WHEN v_me.id = v_from.id THEN NOW() END,
        CASE WHEN v_me.id = v_to.id THEN NOW() END,
        CASE WHEN v_other_can_answer THEN NULL ELSE NOW() END,
        v_me.id, v_me.id, v_version
    );

    -- The person paying back "paid" it; the person receiving "owes" it to them (architecture §9.3).
    PERFORM private.write_shares(v_entry_id, v_group_id, jsonb_build_array(
        jsonb_build_object('memberId', v_from.id, 'paidCents', v_amount, 'owedCents', 0, 'owedTo', '{}'::JSONB),
        jsonb_build_object('memberId', v_to.id, 'paidCents', 0, 'owedCents', v_amount,
            'owedTo', jsonb_build_object(v_from.id::TEXT, v_amount))
    ));
END;
$$;

-- =============================================================================
-- Group notes
-- =============================================================================

-- As in 004, plus the optional note.
CREATE OR REPLACE FUNCTION private.apply_group_create(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_note TEXT;
    v_version BIGINT;
BEGIN
    -- An account rule outside the matrix.
    IF private.is_anonymous() THEN
        RAISE EXCEPTION 'Guests can''t create groups' USING ERRCODE = 'HS403';
    END IF;
    v_note := private.group_note(p_mutation);

    -- Devices stop sending baseCurrency; the column default applies then.
    IF p_mutation->>'baseCurrency' IS NULL THEN
        INSERT INTO public.groups (id, name, note, created_by)
        VALUES (v_group_id, btrim(p_mutation->>'name'), v_note, p_user);
    ELSE
        INSERT INTO public.groups (id, name, note, base_currency, created_by)
        VALUES (v_group_id, btrim(p_mutation->>'name'), v_note, upper(p_mutation->>'baseCurrency'), p_user);
    END IF;

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups SET row_version = v_version WHERE id = v_group_id;

    INSERT INTO public.group_members (id, group_id, user_id, display_name, role, joined_at, row_version)
    VALUES (
        (p_mutation->>'memberId')::UUID,
        v_group_id,
        p_user,
        COALESCE(
            NULLIF(btrim(p_mutation->>'displayName'), ''),
            (SELECT display_name FROM public.profiles WHERE id = p_user)
        ),
        'owner',
        NOW(),
        v_version
    );
END;
$$;

-- Sets or clears the note. Who may: as renaming the group (the owner, not in a completed group).
CREATE OR REPLACE FUNCTION private.apply_group_describe(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_note TEXT;
    v_version BIGINT;
BEGIN
    PERFORM private.require(p_user, v_group_id, 'group.rename');
    v_note := private.group_note(p_mutation);

    v_version := private.next_group_version(v_group_id);
    UPDATE public.groups SET note = v_note, updated_at = NOW(), row_version = v_version WHERE id = v_group_id;
END;
$$;

-- =============================================================================
-- Pull: groups gain note, entries gain category
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
