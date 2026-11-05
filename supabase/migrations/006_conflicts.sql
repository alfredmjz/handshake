-- Migration: 006_conflicts
-- Description: entry.update and entry.delete for bills, and edit conflicts. A change that started from
-- an older version of a bill someone else has changed since is not applied and not rejected: it becomes
-- an entry_conflicts row that the group resolves with conflict.resolve. Each bill's last 20 versions are
-- kept so a conflict can show the version its proposer started from. Payments never conflict: they are
-- only recorded, answered or undone (005).

-- =============================================================================
-- TABLES: entry_conflicts, ledger_entry_versions
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.entry_conflicts (
    -- The id of the mutation that caused it.
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    entry_id UUID NOT NULL REFERENCES public.ledger_entries(id) ON DELETE CASCADE,
    base_version BIGINT NOT NULL,
    -- The bill at base_version (an EntrySnapshot), or NULL once that version is no longer kept.
    base JSONB,
    -- What the proposer wanted, without rowVersion and updatedByMemberId; NULL for a delete.
    proposed JSONB,
    proposed_by_member_id UUID NOT NULL REFERENCES public.group_members(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolved_by_member_id UUID REFERENCES public.group_members(id),
    resolution TEXT CHECK (resolution IN ('kept_current', 'took_proposed', 'merged')),
    row_version BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS entry_conflicts_version_idx ON public.entry_conflicts (group_id, row_version);
CREATE INDEX IF NOT EXISTS entry_conflicts_open_idx ON public.entry_conflicts (entry_id) WHERE resolved_at IS NULL;

-- Server only: no client can read it.
CREATE TABLE IF NOT EXISTS public.ledger_entry_versions (
    entry_id UUID NOT NULL REFERENCES public.ledger_entries(id) ON DELETE CASCADE,
    row_version BIGINT NOT NULL,
    snapshot JSONB NOT NULL,
    PRIMARY KEY (entry_id, row_version)
);

ALTER TABLE public.entry_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_entry_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view their group's conflicts" ON public.entry_conflicts;
CREATE POLICY "Members can view their group's conflicts" ON public.entry_conflicts
    FOR SELECT TO authenticated USING (public.is_group_member(group_id));

REVOKE ALL ON public.entry_conflicts, public.ledger_entry_versions FROM anon, authenticated;
GRANT SELECT ON public.entry_conflicts TO authenticated;

-- =============================================================================
-- Snapshots
-- =============================================================================

-- An EntrySnapshot (docs/architecture.md §11.1) of the bill as stored now. Shares are sorted by memberId
-- and carry owedTo.
CREATE OR REPLACE FUNCTION private.entry_snapshot(p_entry_id UUID)
RETURNS JSONB
LANGUAGE sql SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'description', e.description,
        'amountCents', e.amount_cents,
        'entryDate', e.entry_date,
        'notes', e.notes,
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

-- The same shape for a proposed change, as the bill would be stored.
CREATE OR REPLACE FUNCTION private.entry_proposal(p_entry JSONB)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'description', btrim(p_entry->>'description'),
        'amountCents', (p_entry->>'amountCents')::NUMERIC::BIGINT,
        'entryDate', (p_entry->>'entryDate')::DATE,
        'notes', p_entry->>'notes',
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

-- Keeps the bill's current version, and only its newest 20.
CREATE OR REPLACE FUNCTION private.record_entry_version(p_entry_id UUID)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.ledger_entry_versions (entry_id, row_version, snapshot)
    SELECT e.id, e.row_version, private.entry_snapshot(e.id) FROM public.ledger_entries e WHERE e.id = p_entry_id
    ON CONFLICT (entry_id, row_version) DO UPDATE SET snapshot = EXCLUDED.snapshot;

    DELETE FROM public.ledger_entry_versions
    WHERE entry_id = p_entry_id AND row_version < (
        SELECT min(v.row_version) FROM (
            SELECT row_version FROM public.ledger_entry_versions
            WHERE entry_id = p_entry_id
            ORDER BY row_version DESC
            LIMIT 20
        ) v
    );
END;
$$;

-- Bills written before this migration get their current version recorded.
INSERT INTO public.ledger_entry_versions (entry_id, row_version, snapshot)
SELECT e.id, e.row_version, private.entry_snapshot(e.id) FROM public.ledger_entries e WHERE e.kind = 'expense'
ON CONFLICT (entry_id, row_version) DO NOTHING;

-- =============================================================================
-- Writing bills: every write now records a version
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
BEGIN
    IF p_is_new THEN
        INSERT INTO public.ledger_entries (
            id, group_id, kind, description, amount_cents, items, entry_date, notes,
            created_by_member_id, updated_by_member_id, row_version
        )
        VALUES (
            p_entry_id, p_group_id, 'expense', btrim(p_entry->>'description'),
            (p_entry->>'amountCents')::NUMERIC::BIGINT, p_entry->'items', (p_entry->>'entryDate')::DATE, p_entry->>'notes',
            p_member_id, p_member_id, p_version
        );
    ELSE
        UPDATE public.ledger_entries
        SET description = btrim(p_entry->>'description'),
            amount_cents = (p_entry->>'amountCents')::NUMERIC::BIGINT,
            items = p_entry->'items',
            entry_date = (p_entry->>'entryDate')::DATE,
            notes = p_entry->>'notes',
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

CREATE OR REPLACE FUNCTION private.delete_entry(p_entry_id UUID, p_member_id UUID, p_version BIGINT)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
    UPDATE public.ledger_entries
    SET deleted_at = COALESCE(deleted_at, NOW()), updated_by_member_id = p_member_id, updated_at = NOW(), row_version = p_version
    WHERE id = p_entry_id;

    PERFORM private.record_entry_version(p_entry_id);
END;
$$;

-- Stores a stale change by someone else instead of applying it. p_proposed is NULL for a delete.
CREATE OR REPLACE FUNCTION private.open_conflict(
    p_mutation JSONB,
    p_entry public.ledger_entries,
    p_member_id UUID,
    p_version BIGINT,
    p_proposed JSONB
)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_base_version BIGINT := (p_mutation->>'baseVersion')::NUMERIC::BIGINT;
BEGIN
    INSERT INTO public.entry_conflicts (
        id, group_id, entry_id, base_version, base, proposed, proposed_by_member_id, row_version
    )
    VALUES (
        (p_mutation->>'id')::UUID,
        p_entry.group_id,
        p_entry.id,
        v_base_version,
        (SELECT snapshot FROM public.ledger_entry_versions WHERE entry_id = p_entry.id AND row_version = v_base_version),
        p_proposed,
        p_member_id,
        p_version
    );
END;
$$;

-- A change is stale when the bill has moved past the version it started from and someone else moved
-- it. The same person on two devices is not a conflict: their last change wins.
CREATE OR REPLACE FUNCTION private.is_stale(p_mutation JSONB, p_entry public.ledger_entries, p_member_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
    IF NOT private.is_cents(p_mutation->'baseVersion', 0) THEN
        RAISE EXCEPTION 'baseVersion must be the entry''s version the change started from' USING ERRCODE = 'HS422';
    END IF;
    RETURN p_entry.row_version > (p_mutation->>'baseVersion')::NUMERIC AND p_entry.updated_by_member_id <> p_member_id;
END;
$$;

-- The stored bill an update or delete is about: NULL when the server never stored it (its create was
-- rejected), so the change is accepted and does nothing.
CREATE OR REPLACE FUNCTION private.stored_bill(p_group_id UUID, p_entry_id UUID)
RETURNS public.ledger_entries
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_entry public.ledger_entries;
BEGIN
    SELECT * INTO v_entry FROM public.ledger_entries WHERE id = p_entry_id;
    IF v_entry.id IS NULL THEN
        RETURN NULL;
    END IF;
    IF v_entry.group_id <> p_group_id THEN
        RAISE EXCEPTION 'That entry is in another group' USING ERRCODE = 'HS422';
    END IF;
    IF v_entry.kind = 'payment' THEN
        RAISE EXCEPTION 'A payment can''t be edited or deleted; record one the other way instead' USING ERRCODE = 'HS422';
    END IF;
    RETURN v_entry;
END;
$$;

-- =============================================================================
-- Changes
-- =============================================================================

CREATE OR REPLACE FUNCTION private.apply_entry_update(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_entry public.ledger_entries;
    v_version BIGINT;
BEGIN
    v_me := private.require(p_user, v_group_id, 'entry.update');

    v_entry := private.stored_bill(v_group_id, (p_mutation->>'entryId')::UUID);
    IF v_entry.id IS NULL THEN
        RETURN;
    END IF;
    PERFORM private.validate_entry(v_group_id, p_mutation);

    v_version := private.next_group_version(v_group_id);
    IF private.is_stale(p_mutation, v_entry, v_me.id) THEN
        PERFORM private.open_conflict(p_mutation, v_entry, v_me.id, v_version, private.entry_proposal(p_mutation));
    ELSE
        PERFORM private.save_entry(v_entry.id, v_group_id, p_mutation, v_me.id, v_version, FALSE);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.apply_entry_delete(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_entry public.ledger_entries;
    v_version BIGINT;
BEGIN
    -- Who added it decides the action; a bill never stored is checked as your own.
    v_me := private.caller_member(p_user, v_group_id);
    SELECT * INTO v_entry FROM public.ledger_entries WHERE id = (p_mutation->>'entryId')::UUID;
    v_me := private.require(p_user, v_group_id,
        CASE WHEN v_entry.id IS NULL OR v_entry.created_by_member_id = v_me.id THEN 'entry.delete.own' ELSE 'entry.delete.others' END);

    v_entry := private.stored_bill(v_group_id, (p_mutation->>'entryId')::UUID);
    -- Never stored, or deleted already by anyone: nothing left to do, and nothing to disagree about.
    IF v_entry.id IS NULL OR v_entry.deleted_at IS NOT NULL THEN
        RETURN;
    END IF;

    v_version := private.next_group_version(v_group_id);
    IF private.is_stale(p_mutation, v_entry, v_me.id) THEN
        PERFORM private.open_conflict(p_mutation, v_entry, v_me.id, v_version, NULL);
    ELSE
        PERFORM private.delete_entry(v_entry.id, v_me.id, v_version);
    END IF;
END;
$$;

-- `entry` is the final version (the entry.create fields of a bill) or {"deleted": true}. It is applied
-- as it is, with no stale check: resolving is deciding.
CREATE OR REPLACE FUNCTION private.apply_conflict_resolve(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_conflict public.entry_conflicts;
    v_final JSONB := p_mutation->'entry';
    v_version BIGINT;
BEGIN
    v_me := private.require(p_user, v_group_id, 'conflict.resolve');

    SELECT * INTO v_conflict
    FROM public.entry_conflicts
    WHERE id = (p_mutation->>'conflictId')::UUID AND group_id = v_group_id;

    IF v_conflict.id IS NULL THEN
        RAISE EXCEPTION 'That conflict doesn''t exist in this group' USING ERRCODE = 'HS404';
    END IF;
    IF v_conflict.resolved_at IS NOT NULL THEN
        RAISE EXCEPTION '% already resolved this',
            (SELECT display_name FROM public.group_members WHERE id = v_conflict.resolved_by_member_id)
            USING ERRCODE = 'HS409';
    END IF;
    IF (p_mutation->>'entryId')::UUID IS DISTINCT FROM v_conflict.entry_id THEN
        RAISE EXCEPTION 'That conflict is about another entry' USING ERRCODE = 'HS422';
    END IF;
    IF p_mutation->>'resolution' IS NULL OR p_mutation->>'resolution' NOT IN ('kept_current', 'took_proposed', 'merged') THEN
        RAISE EXCEPTION 'resolution must be kept_current, took_proposed or merged' USING ERRCODE = 'HS422';
    END IF;
    IF jsonb_typeof(v_final) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'A resolution needs the final entry, or deleted: true' USING ERRCODE = 'HS422';
    END IF;

    v_version := private.next_group_version(v_group_id);
    IF v_final->'deleted' = 'true'::JSONB THEN
        PERFORM private.delete_entry(v_conflict.entry_id, v_me.id, v_version);
    ELSE
        PERFORM private.validate_entry(v_group_id, v_final);
        PERFORM private.save_entry(v_conflict.entry_id, v_group_id, v_final, v_me.id, v_version, FALSE);
    END IF;

    UPDATE public.entry_conflicts
    SET resolved_at = NOW(),
        resolved_by_member_id = v_me.id,
        resolution = p_mutation->>'resolution',
        row_version = v_version
    WHERE id = v_conflict.id;
END;
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
