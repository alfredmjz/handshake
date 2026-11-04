-- Migration: 006_conflicts
-- Description: Edit conflicts. An entry.update or entry.delete that started from an older version of an
-- entry someone else has changed since is not applied and not rejected: it becomes an entry_conflicts
-- row that the group resolves with conflict.resolve. Each entry's last 20 versions are kept so a
-- conflict can show the version its proposer started from.

-- =============================================================================
-- TABLES: entry_conflicts, ledger_entry_versions
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.entry_conflicts (
    -- The id of the mutation that caused it.
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    entry_id UUID NOT NULL REFERENCES public.ledger_entries(id) ON DELETE CASCADE,
    base_version BIGINT NOT NULL,
    -- The entry at base_version (an EntrySnapshot), or NULL once that version is no longer kept.
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

-- An EntrySnapshot (docs/architecture.md §11.1) of the entry as stored now.
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
                'owedCents', s.owed_cents
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

-- The same shape for a proposed change, as the entry would be stored.
CREATE OR REPLACE FUNCTION private.entry_proposal(p_entry JSONB)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'description', private.entry_description(p_entry),
        'amountCents', (p_entry->>'amountCents')::NUMERIC::BIGINT,
        'entryDate', (p_entry->>'entryDate')::DATE,
        'notes', p_entry->>'notes',
        'items', CASE WHEN p_entry->>'kind' = 'expense' THEN p_entry->'items' END,
        'shares', (
            SELECT jsonb_agg(jsonb_build_object(
                'memberId', (s->>'memberId')::UUID,
                'paidCents', (s->>'paidCents')::NUMERIC::BIGINT,
                'owedCents', (s->>'owedCents')::NUMERIC::BIGINT
            ) ORDER BY (s->>'memberId')::UUID)
            FROM jsonb_array_elements(p_entry->'shares') s
        ),
        'deletedAt', NULL
    );
$$;

-- Keeps the entry's current version, and only its newest 20.
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

-- Entries written before this migration get their current version recorded.
INSERT INTO public.ledger_entry_versions (entry_id, row_version, snapshot)
SELECT e.id, e.row_version, private.entry_snapshot(e.id) FROM public.ledger_entries e
ON CONFLICT (entry_id, row_version) DO NOTHING;

-- =============================================================================
-- Writing entries: every write now records a version
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
    v_items JSONB := CASE WHEN p_entry->>'kind' = 'expense' THEN p_entry->'items' END;
BEGIN
    IF p_is_new THEN
        INSERT INTO public.ledger_entries (
            id, group_id, kind, description, amount_cents, items, entry_date, notes, recorded_via,
            created_by_member_id, updated_by_member_id, row_version
        )
        VALUES (
            p_entry_id, p_group_id, p_entry->>'kind', private.entry_description(p_entry),
            (p_entry->>'amountCents')::NUMERIC::BIGINT, v_items, (p_entry->>'entryDate')::DATE, p_entry->>'notes',
            p_entry->>'recordedVia', p_member_id, p_member_id, p_version
        );
    ELSE
        UPDATE public.ledger_entries
        SET description = private.entry_description(p_entry),
            amount_cents = (p_entry->>'amountCents')::NUMERIC::BIGINT,
            items = v_items,
            entry_date = (p_entry->>'entryDate')::DATE,
            notes = p_entry->>'notes',
            updated_by_member_id = p_member_id,
            updated_at = NOW(),
            deleted_at = NULL,
            row_version = p_version
        WHERE id = p_entry_id;
    END IF;

    DELETE FROM public.ledger_shares WHERE entry_id = p_entry_id;
    INSERT INTO public.ledger_shares (entry_id, group_id, member_id, paid_cents, owed_cents)
    SELECT p_entry_id, p_group_id, (s->>'memberId')::UUID, (s->>'paidCents')::NUMERIC::BIGINT, (s->>'owedCents')::NUMERIC::BIGINT
    FROM jsonb_array_elements(p_entry->'shares') s;

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

-- A change is stale when the entry has moved past the version it started from and someone else moved
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
    v_me := private.require_member(p_user, v_group_id, ARRAY['owner', 'member']);

    SELECT * INTO v_entry FROM public.ledger_entries WHERE id = (p_mutation->>'entryId')::UUID;
    -- Its create was rejected, so it never reached the server: accept the update and do nothing.
    IF v_entry.id IS NULL THEN
        RETURN;
    END IF;
    IF v_entry.group_id <> v_group_id THEN
        RAISE EXCEPTION 'That entry is in another group' USING ERRCODE = 'HS422';
    END IF;
    IF v_entry.kind IS DISTINCT FROM p_mutation->>'kind' THEN
        RAISE EXCEPTION 'An entry can''t change between expense and payment' USING ERRCODE = 'HS422';
    END IF;
    PERFORM private.validate_entry(v_group_id, p_mutation || jsonb_build_object('recordedVia', v_entry.recorded_via));

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
    v_me := private.require_member(p_user, v_group_id, ARRAY['owner', 'member', 'guest']);

    SELECT * INTO v_entry FROM public.ledger_entries WHERE id = (p_mutation->>'entryId')::UUID;
    IF v_entry.id IS NULL THEN
        RETURN;
    END IF;
    IF v_entry.group_id <> v_group_id THEN
        RAISE EXCEPTION 'That entry is in another group' USING ERRCODE = 'HS422';
    END IF;
    IF v_me.role = 'guest' AND v_entry.created_by_member_id <> v_me.id THEN
        RAISE EXCEPTION 'Guests can only delete entries they added' USING ERRCODE = 'HS403';
    END IF;
    -- Deleted already, by anyone: nothing left to do, and nothing to disagree about.
    IF v_entry.deleted_at IS NOT NULL THEN
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

-- `entry` is the final version (the entry.create fields; kind may be left out) or {"deleted": true}. It
-- is applied as it is, with no stale check: resolving is deciding.
CREATE OR REPLACE FUNCTION private.apply_conflict_resolve(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_conflict public.entry_conflicts;
    v_entry public.ledger_entries;
    v_final JSONB := p_mutation->'entry';
    v_version BIGINT;
BEGIN
    v_me := private.require_member(p_user, v_group_id, ARRAY['owner', 'member']);

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

    SELECT * INTO v_entry FROM public.ledger_entries WHERE id = v_conflict.entry_id;
    v_version := private.next_group_version(v_group_id);

    IF v_final->'deleted' = 'true'::JSONB THEN
        PERFORM private.delete_entry(v_entry.id, v_me.id, v_version);
    ELSE
        v_final := jsonb_build_object('kind', v_entry.kind, 'recordedVia', v_entry.recorded_via)
            || (v_final - 'recordedVia');
        IF v_final->>'kind' IS DISTINCT FROM v_entry.kind THEN
            RAISE EXCEPTION 'An entry can''t change between expense and payment' USING ERRCODE = 'HS422';
        END IF;
        PERFORM private.validate_entry(v_group_id, v_final);
        PERFORM private.save_entry(v_entry.id, v_group_id, v_final, v_me.id, v_version, FALSE);
    END IF;

    UPDATE public.entry_conflicts
    SET resolved_at = NOW(),
        resolved_by_member_id = v_me.id,
        resolution = p_mutation->>'resolution',
        row_version = v_version
    WHERE id = v_conflict.id;
END;
$$;

-- =============================================================================
-- Pull: conflicts
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
