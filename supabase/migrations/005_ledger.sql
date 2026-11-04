-- Migration: 005_ledger
-- Description: Entries (expenses and payments) and their shares; the rounding rule in SQL
-- (private.compute_shares, the twin of computeShares in src/lib/ledger.ts, pinned to the same cases in
-- tests/fixtures/ledger-cases.ts); the entry checks; and entry.create, entry.update and entry.delete.

-- =============================================================================
-- TABLES: ledger_entries, ledger_shares
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ledger_entries (
    id UUID PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'payment')),
    description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 120),
    amount_cents BIGINT NOT NULL CHECK (amount_cents BETWEEN 1 AND 1000000000000),
    -- The bill as the device wrote it ({ id, description, amountCents, paidBy, splitAmong }), kept so the
    -- editor reopens as it was left. NULL for payments.
    items JSONB,
    entry_date DATE NOT NULL,
    notes TEXT CHECK (char_length(notes) <= 1000),
    recorded_via TEXT CHECK (recorded_via = 'settle_up'),
    -- Member ids, not user ids, so "Added by Kim" survives Kim's guest login being deleted.
    created_by_member_id UUID NOT NULL REFERENCES public.group_members(id),
    updated_by_member_id UUID NOT NULL REFERENCES public.group_members(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    row_version BIGINT NOT NULL DEFAULT 0,
    CHECK ((kind = 'expense') = (items IS NOT NULL)),
    CHECK (recorded_via IS NULL OR kind = 'payment')
);

-- Lets a share name its member and group together, so it can't point at someone from another group.
CREATE UNIQUE INDEX IF NOT EXISTS group_members_group_id_idx ON public.group_members (group_id, id);

CREATE TABLE IF NOT EXISTS public.ledger_shares (
    entry_id UUID NOT NULL REFERENCES public.ledger_entries(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    member_id UUID NOT NULL,
    paid_cents BIGINT NOT NULL CHECK (paid_cents >= 0),
    owed_cents BIGINT NOT NULL CHECK (owed_cents >= 0),
    PRIMARY KEY (entry_id, member_id),
    FOREIGN KEY (group_id, member_id) REFERENCES public.group_members (group_id, id)
);

CREATE INDEX IF NOT EXISTS ledger_entries_version_idx ON public.ledger_entries (group_id, row_version);
CREATE INDEX IF NOT EXISTS ledger_entries_date_idx ON public.ledger_entries (group_id, entry_date);
CREATE INDEX IF NOT EXISTS ledger_shares_member_idx ON public.ledger_shares (member_id);

ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view their group's entries" ON public.ledger_entries;
CREATE POLICY "Members can view their group's entries" ON public.ledger_entries
    FOR SELECT TO authenticated USING (public.is_group_member(group_id));

DROP POLICY IF EXISTS "Members can view their group's shares" ON public.ledger_shares;
CREATE POLICY "Members can view their group's shares" ON public.ledger_shares
    FOR SELECT TO authenticated USING (public.is_group_member(group_id));

REVOKE ALL ON public.ledger_entries, public.ledger_shares FROM anon, authenticated;
GRANT SELECT ON public.ledger_entries, public.ledger_shares TO authenticated;

-- =============================================================================
-- Rounding: private.compute_shares
-- =============================================================================

-- Exactly docs/architecture.md §9.3, in NUMERIC so nothing is ever rounded by accident:
-- 1. paid = what each person's items cost.
-- 2. D = lcm of every item's split size; num = Σ amount × (D / n) over the items a person is in,
--    so num / D is their exact share.
-- 3. owed = num / D rounded half up.
-- 4. Any difference from the total goes on the absorber: the biggest payer, a tie going to whoever paid
--    the earliest item.
-- 5. If that would make the absorber's share negative, it stops at 0 and the rest comes off the other
--    shares a cent each, the ones rounded up most first, ties in bill order.
-- Shares come back in bill order: people as they first appear in the splits, then payers in no split.
-- The items must already have passed private.validate_entry.
CREATE OR REPLACE FUNCTION private.compute_shares(p_items JSONB)
RETURNS TABLE (member_id UUID, paid_cents BIGINT, owed_cents BIGINT)
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
    v_d NUMERIC := 1;
    v_size INT;
    v_ids UUID[];
    v_paid NUMERIC[];
    v_num NUMERIC[];
    v_first_paid BIGINT[];
    v_owed NUMERIC[];
    v_diff NUMERIC;
    v_absorber INT;
    v_short NUMERIC;
    v_k INT;
BEGIN
    FOR v_size IN SELECT jsonb_array_length(value->'splitAmong') FROM jsonb_array_elements(p_items) LOOP
        v_d := lcm(v_d, v_size::NUMERIC);
    END LOOP;

    WITH items AS (
        SELECT
            t.ord AS item_no,
            (t.item->>'amountCents')::NUMERIC AS amount,
            (t.item->>'paidBy')::UUID AS payer,
            t.item->'splitAmong' AS split
        FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(item, ord)
    ),
    parts AS (
        SELECT i.item_no, s.pos, (s.who #>> '{}')::UUID AS person, i.amount * (v_d / jsonb_array_length(i.split)) AS part
        FROM items i, jsonb_array_elements(i.split) WITH ORDINALITY AS s(who, pos)
    ),
    appearances AS (
        SELECT person, 0 AS late, item_no, pos FROM parts
        UNION ALL
        SELECT payer, 1, item_no, 0 FROM items
    ),
    people AS (
        SELECT DISTINCT ON (a.person) a.person, a.late, a.item_no, a.pos
        FROM appearances a
        ORDER BY a.person, a.late, a.item_no, a.pos
    )
    SELECT
        array_agg(p.person ORDER BY p.late, p.item_no, p.pos),
        array_agg(COALESCE((SELECT sum(i.amount) FROM items i WHERE i.payer = p.person), 0) ORDER BY p.late, p.item_no, p.pos),
        array_agg(COALESCE((SELECT sum(x.part) FROM parts x WHERE x.person = p.person), 0) ORDER BY p.late, p.item_no, p.pos),
        array_agg((SELECT min(i.item_no) FROM items i WHERE i.payer = p.person) ORDER BY p.late, p.item_no, p.pos)
    INTO v_ids, v_paid, v_num, v_first_paid
    FROM people p;

    v_owed := ARRAY(SELECT floor((2 * u.num + v_d) / (2 * v_d)) FROM unnest(v_num) WITH ORDINALITY AS u(num, k) ORDER BY u.k);
    v_diff := (SELECT sum(x) FROM unnest(v_paid) AS x) - (SELECT sum(x) FROM unnest(v_owed) AS x);

    IF v_diff <> 0 THEN
        SELECT u.k INTO v_absorber
        FROM unnest(v_paid, v_first_paid) WITH ORDINALITY AS u(paid, first_paid, k)
        WHERE u.paid > 0
        ORDER BY u.paid DESC, u.first_paid
        LIMIT 1;

        IF v_owed[v_absorber] + v_diff >= 0 THEN
            v_owed[v_absorber] := v_owed[v_absorber] + v_diff;
        ELSE
            v_short := -(v_owed[v_absorber] + v_diff);
            v_owed[v_absorber] := 0;
            FOR v_k IN
                SELECT u.k
                FROM unnest(v_owed, v_num) WITH ORDINALITY AS u(owed, num, k)
                WHERE u.k <> v_absorber
                ORDER BY u.owed * v_d - u.num DESC, u.k
                LIMIT v_short::BIGINT
            LOOP
                v_owed[v_k] := v_owed[v_k] - 1;
            END LOOP;
        END IF;
    END IF;

    RETURN QUERY
    SELECT u.id, u.paid::BIGINT, u.owed::BIGINT
    FROM unnest(v_ids, v_paid, v_owed) WITH ORDINALITY AS u(id, paid, owed, k)
    ORDER BY u.k;
END;
$$;

-- =============================================================================
-- Entry checks
-- =============================================================================

-- A whole number of cents from p_min to 10^12, as a JSON number.
CREATE OR REPLACE FUNCTION private.is_cents(p_value JSONB, p_min NUMERIC)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT CASE WHEN jsonb_typeof(p_value) = 'number' THEN
        (p_value #>> '{}')::NUMERIC = trunc((p_value #>> '{}')::NUMERIC)
        AND (p_value #>> '{}')::NUMERIC BETWEEN p_min AND 1000000000000
    ELSE FALSE END;
$$;

-- Payments without a description are called "Payment"; descriptions are stored trimmed.
CREATE OR REPLACE FUNCTION private.entry_description(p_entry JSONB)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT CASE WHEN p_entry->>'kind' = 'payment'
        THEN COALESCE(NULLIF(btrim(p_entry->>'description'), ''), 'Payment')
        ELSE btrim(p_entry->>'description') END;
$$;

-- Every HS422 rule in the spec's "Entry checks on the server". p_entry carries the entry fields of
-- entry.create (kind, description, amountCents, entryDate, notes, items, shares, recordedVia). Members
-- who have left still count as in the group, so old bills stay valid.
CREATE OR REPLACE FUNCTION private.validate_entry(p_group_id UUID, p_entry JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_kind TEXT := p_entry->>'kind';
    v_amount NUMERIC;
    v_shares JSONB := p_entry->'shares';
    v_items JSONB := COALESCE(p_entry->'items', 'null'::JSONB);
    v_item JSONB;
    v_people TEXT[];
BEGIN
    IF v_kind IS NULL OR v_kind NOT IN ('expense', 'payment') THEN
        RAISE EXCEPTION 'An entry is an expense or a payment' USING ERRCODE = 'HS422';
    END IF;
    IF jsonb_typeof(p_entry->'description') IS DISTINCT FROM 'string' AND NOT (v_kind = 'payment' AND p_entry->>'description' IS NULL) THEN
        RAISE EXCEPTION 'The description must be text' USING ERRCODE = 'HS422';
    END IF;
    IF char_length(private.entry_description(p_entry)) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'The description must be 1 to 120 characters' USING ERRCODE = 'HS422';
    END IF;
    IF NOT private.is_cents(p_entry->'amountCents', 1) THEN
        RAISE EXCEPTION 'The amount must be a whole number of cents from 1 to 10^12' USING ERRCODE = 'HS422';
    END IF;
    v_amount := (p_entry->>'amountCents')::NUMERIC;
    IF COALESCE(p_entry->>'entryDate', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'The date must be YYYY-MM-DD' USING ERRCODE = 'HS422';
    END IF;
    PERFORM (p_entry->>'entryDate')::DATE;
    IF p_entry->>'notes' IS NOT NULL AND (jsonb_typeof(p_entry->'notes') <> 'string' OR char_length(p_entry->>'notes') > 1000) THEN
        RAISE EXCEPTION 'Notes must be text of at most 1000 characters' USING ERRCODE = 'HS422';
    END IF;
    IF p_entry->>'recordedVia' IS NOT NULL AND (p_entry->>'recordedVia' <> 'settle_up' OR v_kind <> 'payment') THEN
        RAISE EXCEPTION 'recordedVia can only be settle_up, on a payment' USING ERRCODE = 'HS422';
    END IF;

    -- Shares: one per person, whole cents, adding up to the amount both ways.
    IF jsonb_typeof(v_shares) IS DISTINCT FROM 'array' OR jsonb_array_length(v_shares) = 0 THEN
        RAISE EXCEPTION 'An entry needs its shares' USING ERRCODE = 'HS422';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_shares) s
        WHERE NOT private.is_cents(s->'paidCents', 0) OR NOT private.is_cents(s->'owedCents', 0)
    ) THEN
        RAISE EXCEPTION 'Each share needs whole, non-negative paidCents and owedCents' USING ERRCODE = 'HS422';
    END IF;
    IF (SELECT count(DISTINCT lower(s->>'memberId')) <> count(*) FROM jsonb_array_elements(v_shares) s) THEN
        RAISE EXCEPTION 'Someone appears twice in the shares' USING ERRCODE = 'HS422';
    END IF;
    IF (SELECT sum((s->>'paidCents')::NUMERIC) <> v_amount OR sum((s->>'owedCents')::NUMERIC) <> v_amount
        FROM jsonb_array_elements(v_shares) s) THEN
        RAISE EXCEPTION 'The shares must add up to the amount' USING ERRCODE = 'HS422';
    END IF;

    IF v_kind = 'expense' THEN
        IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) NOT BETWEEN 1 AND 50 THEN
            RAISE EXCEPTION 'An expense needs 1 to 50 items' USING ERRCODE = 'HS422';
        END IF;
        FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) LOOP
            IF NOT private.is_cents(v_item->'amountCents', 1) THEN
                RAISE EXCEPTION 'Each item needs a whole amount of cents from 1 to 10^12' USING ERRCODE = 'HS422';
            END IF;
            IF v_item->>'description' IS NOT NULL
                AND (jsonb_typeof(v_item->'description') <> 'string' OR char_length(v_item->>'description') > 60) THEN
                RAISE EXCEPTION 'An item''s description must be text of at most 60 characters' USING ERRCODE = 'HS422';
            END IF;
            IF jsonb_typeof(v_item->'splitAmong') IS DISTINCT FROM 'array' OR jsonb_array_length(v_item->'splitAmong') = 0 THEN
                RAISE EXCEPTION 'Each item needs someone to split it' USING ERRCODE = 'HS422';
            END IF;
            IF (SELECT count(DISTINCT lower(p #>> '{}')) <> count(*) FROM jsonb_array_elements(v_item->'splitAmong') p) THEN
                RAISE EXCEPTION 'Someone appears twice in an item''s split' USING ERRCODE = 'HS422';
            END IF;
        END LOOP;
        IF (SELECT sum((i->>'amountCents')::NUMERIC) FROM jsonb_array_elements(v_items) i) <> v_amount THEN
            RAISE EXCEPTION 'The items must add up to the amount' USING ERRCODE = 'HS422';
        END IF;
    ELSE
        IF v_items <> 'null'::JSONB THEN
            RAISE EXCEPTION 'A payment has no items' USING ERRCODE = 'HS422';
        END IF;
        IF jsonb_array_length(v_shares) <> 2 OR NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_shares) payer, jsonb_array_elements(v_shares) payee
            WHERE (payer->>'paidCents')::NUMERIC = v_amount AND (payer->>'owedCents')::NUMERIC = 0
                AND (payee->>'paidCents')::NUMERIC = 0 AND (payee->>'owedCents')::NUMERIC = v_amount
        ) THEN
            RAISE EXCEPTION 'A payment is one person paying another the whole amount' USING ERRCODE = 'HS422';
        END IF;
    END IF;

    -- Everyone named must be in this group (members who left included).
    v_people := ARRAY(
        SELECT s->>'memberId' FROM jsonb_array_elements(v_shares) s
        UNION ALL
        SELECT i->>'paidBy' FROM jsonb_array_elements(CASE WHEN v_kind = 'expense' THEN v_items ELSE '[]' END) i
        UNION ALL
        SELECT p #>> '{}'
        FROM jsonb_array_elements(CASE WHEN v_kind = 'expense' THEN v_items ELSE '[]' END) i,
            jsonb_array_elements(i->'splitAmong') p
    );
    IF EXISTS (
        SELECT 1 FROM unnest(v_people) AS person
        WHERE person IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.group_members gm WHERE gm.group_id = p_group_id AND gm.id::TEXT = lower(person)
        )
    ) THEN
        RAISE EXCEPTION 'Everyone in an entry must be in this group' USING ERRCODE = 'HS422';
    END IF;

    IF v_kind = 'expense' AND EXISTS (
        (
            SELECT c.member_id, c.paid_cents, c.owed_cents FROM private.compute_shares(v_items) c
            EXCEPT
            SELECT (s->>'memberId')::UUID, (s->>'paidCents')::NUMERIC::BIGINT, (s->>'owedCents')::NUMERIC::BIGINT
            FROM jsonb_array_elements(v_shares) s
        )
        UNION ALL
        (
            SELECT (s->>'memberId')::UUID, (s->>'paidCents')::NUMERIC::BIGINT, (s->>'owedCents')::NUMERIC::BIGINT
            FROM jsonb_array_elements(v_shares) s
            EXCEPT
            SELECT c.member_id, c.paid_cents, c.owed_cents FROM private.compute_shares(v_items) c
        )
    ) THEN
        RAISE EXCEPTION 'The shares don''t match the items' USING ERRCODE = 'HS422';
    END IF;
EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'The entry has a malformed value: %', SQLERRM USING ERRCODE = 'HS422';
END;
$$;

-- =============================================================================
-- Writing entries
-- =============================================================================

-- Writes an entry and replaces all of its shares, at p_version. p_is_new: entry.create (a plain insert,
-- so an id already in use fails) rather than an update, which also restores a deleted entry.
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
END;
$$;

-- A soft delete: the shares stay, so the entry can be restored, and balances skip deleted entries.
CREATE OR REPLACE FUNCTION private.delete_entry(p_entry_id UUID, p_member_id UUID, p_version BIGINT)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
    UPDATE public.ledger_entries
    SET deleted_at = COALESCE(deleted_at, NOW()), updated_by_member_id = p_member_id, updated_at = NOW(), row_version = p_version
    WHERE id = p_entry_id;
END;
$$;

-- =============================================================================
-- Changes
-- =============================================================================

CREATE OR REPLACE FUNCTION private.apply_entry_create(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
BEGIN
    v_me := private.require_member(p_user, v_group_id, ARRAY['owner', 'member', 'guest']);

    IF p_mutation->>'recordedVia' IS NOT NULL AND v_me.role <> 'owner' THEN
        RAISE EXCEPTION 'Only the group''s owner can use the settle-up tracker' USING ERRCODE = 'HS403';
    END IF;
    PERFORM private.validate_entry(v_group_id, p_mutation);

    PERFORM private.save_entry(
        (p_mutation->>'entryId')::UUID, v_group_id, p_mutation, v_me.id, private.next_group_version(v_group_id), TRUE
    );
END;
$$;

-- recordedVia is not editable: an update keeps the stored value.
CREATE OR REPLACE FUNCTION private.apply_entry_update(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_entry public.ledger_entries;
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

    PERFORM private.save_entry(v_entry.id, v_group_id, p_mutation, v_me.id, private.next_group_version(v_group_id), FALSE);
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
    IF v_entry.deleted_at IS NOT NULL THEN
        RETURN;
    END IF;

    PERFORM private.delete_entry(v_entry.id, v_me.id, private.next_group_version(v_group_id));
END;
$$;

-- =============================================================================
-- Pull: entries, each with all of its shares
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
