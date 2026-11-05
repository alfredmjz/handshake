-- Migration: 005_ledger
-- Description: Entries (bills and payments), their shares and share parts (what each person owes each
-- payer, the shares' owedTo); the rounding rule in SQL (private.compute_shares, the twin of computeShares
-- in src/lib/ledger.ts, pinned to the same cases in tests/fixtures/ledger-cases.ts); the bill checks;
-- entry.create for bills; and the payment handshake: payment.record, payment.confirm, payment.decline
-- and payment.undo (spec decision 17). entry.update and entry.delete are in 006, with conflicts.

-- =============================================================================
-- TABLES: ledger_entries, ledger_shares, ledger_share_parts
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
    -- Payments only: the handshake.
    payment_status TEXT CHECK (payment_status IN ('pending', 'confirmed', 'declined', 'undone')),
    payer_confirmed_at TIMESTAMPTZ,
    receiver_confirmed_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    close_note TEXT CHECK (char_length(close_note) <= 200),
    -- Member ids, not user ids, so "Added by Kim" survives Kim's login being deleted.
    created_by_member_id UUID NOT NULL REFERENCES public.group_members(id),
    updated_by_member_id UUID NOT NULL REFERENCES public.group_members(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    row_version BIGINT NOT NULL DEFAULT 0,
    CHECK ((kind = 'expense') = (items IS NOT NULL)),
    CHECK ((kind = 'expense') = (payment_status IS NULL))
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

-- What member_id owes payer_member_id from the entry. For each share, the parts add up to owed_cents;
-- only non-zero parts are stored, and a payer's own part is one of them.
CREATE TABLE IF NOT EXISTS public.ledger_share_parts (
    entry_id UUID NOT NULL REFERENCES public.ledger_entries(id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    member_id UUID NOT NULL,
    payer_member_id UUID NOT NULL,
    owed_cents BIGINT NOT NULL CHECK (owed_cents > 0),
    PRIMARY KEY (entry_id, member_id, payer_member_id),
    FOREIGN KEY (entry_id, member_id) REFERENCES public.ledger_shares (entry_id, member_id) ON DELETE CASCADE,
    FOREIGN KEY (group_id, payer_member_id) REFERENCES public.group_members (group_id, id)
);

CREATE INDEX IF NOT EXISTS ledger_entries_version_idx ON public.ledger_entries (group_id, row_version);
CREATE INDEX IF NOT EXISTS ledger_entries_date_idx ON public.ledger_entries (group_id, entry_date);
CREATE INDEX IF NOT EXISTS ledger_entries_pending_idx ON public.ledger_entries (group_id) WHERE payment_status = 'pending';
CREATE INDEX IF NOT EXISTS ledger_shares_member_idx ON public.ledger_shares (member_id);
CREATE INDEX IF NOT EXISTS ledger_share_parts_payer_idx ON public.ledger_share_parts (payer_member_id);

ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_share_parts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view their group's entries" ON public.ledger_entries;
CREATE POLICY "Members can view their group's entries" ON public.ledger_entries
    FOR SELECT TO authenticated USING (public.is_group_member(group_id));

DROP POLICY IF EXISTS "Members can view their group's shares" ON public.ledger_shares;
CREATE POLICY "Members can view their group's shares" ON public.ledger_shares
    FOR SELECT TO authenticated USING (public.is_group_member(group_id));

DROP POLICY IF EXISTS "Members can view their group's share parts" ON public.ledger_share_parts;
CREATE POLICY "Members can view their group's share parts" ON public.ledger_share_parts
    FOR SELECT TO authenticated USING (public.is_group_member(group_id));

REVOKE ALL ON public.ledger_entries, public.ledger_shares, public.ledger_share_parts FROM anon, authenticated;
GRANT SELECT ON public.ledger_entries, public.ledger_shares, public.ledger_share_parts TO authenticated;

-- =============================================================================
-- Rounding: private.compute_shares
-- =============================================================================

-- Exactly docs/architecture.md §9.3, in NUMERIC so nothing is ever rounded by accident, for each payer
-- separately:
-- 1. paid = what each person's items cost.
-- 2. Over the payer's items: D = lcm of their split sizes; num = Σ amount × (D / n) over those items a
--    person is in, so num / D is their exact share of that payer's items.
-- 3. part = num / D rounded half up.
-- 4. Any difference from what the payer paid goes on the payer's own part.
-- 5. If that would make it negative, it stops at 0 and the rest comes off the other parts of that payer,
--    a cent each, the ones rounded up most first, ties in bill order.
-- 6. owed = Σ parts; owed_to = the non-zero parts, payer member id -> cents.
-- Shares come back in bill order: people as they first appear in the splits, then payers in no split.
-- The items must already have passed private.validate_entry.
DROP FUNCTION IF EXISTS private.compute_shares(JSONB);
CREATE FUNCTION private.compute_shares(p_items JSONB)
RETURNS TABLE (member_id UUID, paid_cents BIGINT, owed_cents BIGINT, owed_to JSONB)
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
    v_ids UUID[];
    v_paid NUMERIC[];
    v_owed NUMERIC[];
    v_owed_to JSONB[];
    v_payer UUID;
    v_p INT;
    v_d NUMERIC;
    v_size INT;
    v_num NUMERIC[];
    v_part NUMERIC[];
    v_diff NUMERIC;
    v_short NUMERIC;
    v_k INT;
BEGIN
    WITH items AS (
        SELECT
            t.ord AS item_no,
            (t.item->>'amountCents')::NUMERIC AS amount,
            (t.item->>'paidBy')::UUID AS payer,
            t.item->'splitAmong' AS split
        FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(item, ord)
    ),
    appearances AS (
        SELECT (s.who #>> '{}')::UUID AS person, 0 AS late, i.item_no, s.pos
        FROM items i, jsonb_array_elements(i.split) WITH ORDINALITY AS s(who, pos)
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
        array_agg(COALESCE((SELECT sum(i.amount) FROM items i WHERE i.payer = p.person), 0) ORDER BY p.late, p.item_no, p.pos)
    INTO v_ids, v_paid
    FROM people p;

    v_owed := array_fill(0::NUMERIC, ARRAY[cardinality(v_ids)]);
    v_owed_to := array_fill('{}'::JSONB, ARRAY[cardinality(v_ids)]);

    FOR v_payer IN SELECT DISTINCT (i.value->>'paidBy')::UUID FROM jsonb_array_elements(p_items) i LOOP
        v_p := array_position(v_ids, v_payer);

        v_d := 1;
        FOR v_size IN
            SELECT jsonb_array_length(i.value->'splitAmong') FROM jsonb_array_elements(p_items) i
            WHERE (i.value->>'paidBy')::UUID = v_payer
        LOOP
            v_d := lcm(v_d, v_size::NUMERIC);
        END LOOP;

        v_num := ARRAY(
            SELECT COALESCE((
                SELECT sum((i.value->>'amountCents')::NUMERIC * (v_d / jsonb_array_length(i.value->'splitAmong')))
                FROM jsonb_array_elements(p_items) i, jsonb_array_elements(i.value->'splitAmong') s
                WHERE (i.value->>'paidBy')::UUID = v_payer AND (s.value #>> '{}')::UUID = u.id
            ), 0)
            FROM unnest(v_ids) WITH ORDINALITY AS u(id, k)
            ORDER BY u.k
        );
        v_part := ARRAY(SELECT floor((2 * u.num + v_d) / (2 * v_d)) FROM unnest(v_num) WITH ORDINALITY AS u(num, k) ORDER BY u.k);
        v_diff := (SELECT sum((i.value->>'amountCents')::NUMERIC) FROM jsonb_array_elements(p_items) i WHERE (i.value->>'paidBy')::UUID = v_payer)
            - (SELECT sum(x) FROM unnest(v_part) AS x);

        IF v_part[v_p] + v_diff >= 0 THEN
            v_part[v_p] := v_part[v_p] + v_diff;
        ELSE
            v_short := -(v_part[v_p] + v_diff);
            v_part[v_p] := 0;
            FOR v_k IN
                SELECT u.k
                FROM unnest(v_part, v_num) WITH ORDINALITY AS u(part, num, k)
                WHERE u.k <> v_p
                ORDER BY u.part * v_d - u.num DESC, u.k
                LIMIT v_short::BIGINT
            LOOP
                v_part[v_k] := v_part[v_k] - 1;
            END LOOP;
        END IF;

        FOR v_k IN 1 .. cardinality(v_ids) LOOP
            IF v_part[v_k] > 0 THEN
                v_owed[v_k] := v_owed[v_k] + v_part[v_k];
                v_owed_to[v_k] := v_owed_to[v_k] || jsonb_build_object(v_payer::TEXT, v_part[v_k]::BIGINT);
            END IF;
        END LOOP;
    END LOOP;

    RETURN QUERY
    SELECT u.id, u.paid::BIGINT, u.owed::BIGINT, u.owed_to
    FROM unnest(v_ids, v_paid, v_owed, v_owed_to) WITH ORDINALITY AS u(id, paid, owed, owed_to, k)
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

-- A bill's shares as rows, with owedTo as owed_to: ids lower-cased, zero parts left out. The shares must
-- already have passed private.validate_entry.
CREATE OR REPLACE FUNCTION private.share_rows(p_shares JSONB)
RETURNS TABLE (member_id UUID, paid_cents BIGINT, owed_cents BIGINT, owed_to JSONB)
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT
        lower(s->>'memberId')::UUID,
        (s->>'paidCents')::NUMERIC::BIGINT,
        (s->>'owedCents')::NUMERIC::BIGINT,
        COALESCE((
            SELECT jsonb_object_agg(lower(o.key), (o.value #>> '{}')::NUMERIC::BIGINT)
            FROM jsonb_each(s->'owedTo') o
            WHERE (o.value #>> '{}')::NUMERIC > 0
        ), '{}'::JSONB)
    FROM jsonb_array_elements(p_shares) s;
$$;

-- Every HS422 rule for a bill in the spec's "Entry checks on the server". p_entry carries the fields of
-- entry.create (description, amountCents, entryDate, notes, items, shares with owedTo; kind is "expense"
-- or left out). Payments have their own mutations. Members who have left still count as in the group,
-- so old bills stay valid.
CREATE OR REPLACE FUNCTION private.validate_entry(p_group_id UUID, p_entry JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_kind TEXT := COALESCE(p_entry->>'kind', 'expense');
    v_amount NUMERIC;
    v_shares JSONB := p_entry->'shares';
    v_items JSONB := COALESCE(p_entry->'items', 'null'::JSONB);
    v_item JSONB;
    v_people TEXT[];
BEGIN
    IF v_kind = 'payment' THEN
        RAISE EXCEPTION 'Payments are recorded with payment.record' USING ERRCODE = 'HS422';
    END IF;
    IF v_kind <> 'expense' THEN
        RAISE EXCEPTION 'An entry is a bill (expense) or a payment' USING ERRCODE = 'HS422';
    END IF;
    IF jsonb_typeof(p_entry->'description') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'The description must be text' USING ERRCODE = 'HS422';
    END IF;
    IF char_length(btrim(p_entry->>'description')) NOT BETWEEN 1 AND 120 THEN
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

    -- Shares: one per person, whole cents, adding up to the amount both ways, each split by payer.
    IF jsonb_typeof(v_shares) IS DISTINCT FROM 'array' OR jsonb_array_length(v_shares) = 0 THEN
        RAISE EXCEPTION 'A bill needs its shares' USING ERRCODE = 'HS422';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_shares) s
        WHERE NOT private.is_cents(s->'paidCents', 0) OR NOT private.is_cents(s->'owedCents', 0)
            OR jsonb_typeof(s->'owedTo') IS DISTINCT FROM 'object'
            OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(s->'owedTo') = 'object' THEN s->'owedTo' ELSE '{}' END) o
                WHERE NOT private.is_cents(o.value, 0))
    ) THEN
        RAISE EXCEPTION 'Each share needs whole, non-negative paidCents and owedCents, and owedTo by payer' USING ERRCODE = 'HS422';
    END IF;
    IF (SELECT count(DISTINCT lower(s->>'memberId')) <> count(*) FROM jsonb_array_elements(v_shares) s) THEN
        RAISE EXCEPTION 'Someone appears twice in the shares' USING ERRCODE = 'HS422';
    END IF;
    IF (SELECT sum((s->>'paidCents')::NUMERIC) <> v_amount OR sum((s->>'owedCents')::NUMERIC) <> v_amount
        FROM jsonb_array_elements(v_shares) s) THEN
        RAISE EXCEPTION 'The shares must add up to the amount' USING ERRCODE = 'HS422';
    END IF;

    IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) NOT BETWEEN 1 AND 50 THEN
        RAISE EXCEPTION 'A bill needs 1 to 50 items' USING ERRCODE = 'HS422';
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

    -- Everyone named must be in this group (members who left included).
    v_people := ARRAY(
        SELECT s->>'memberId' FROM jsonb_array_elements(v_shares) s
        UNION ALL
        SELECT o.key FROM jsonb_array_elements(v_shares) s, jsonb_object_keys(s->'owedTo') o(key)
        UNION ALL
        SELECT i->>'paidBy' FROM jsonb_array_elements(v_items) i
        UNION ALL
        SELECT p #>> '{}' FROM jsonb_array_elements(v_items) i, jsonb_array_elements(i->'splitAmong') p
    );
    IF EXISTS (
        SELECT 1 FROM unnest(v_people) AS person
        WHERE person IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.group_members gm WHERE gm.group_id = p_group_id AND gm.id::TEXT = lower(person)
        )
    ) THEN
        RAISE EXCEPTION 'Everyone in a bill must be in this group' USING ERRCODE = 'HS422';
    END IF;

    IF EXISTS (
        (SELECT * FROM private.compute_shares(v_items) EXCEPT SELECT * FROM private.share_rows(v_shares))
        UNION ALL
        (SELECT * FROM private.share_rows(v_shares) EXCEPT SELECT * FROM private.compute_shares(v_items))
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

-- Replaces all of an entry's shares and parts.
CREATE OR REPLACE FUNCTION private.write_shares(p_entry_id UUID, p_group_id UUID, p_shares JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
    DELETE FROM public.ledger_shares WHERE entry_id = p_entry_id;
    INSERT INTO public.ledger_shares (entry_id, group_id, member_id, paid_cents, owed_cents)
    SELECT p_entry_id, p_group_id, s.member_id, s.paid_cents, s.owed_cents FROM private.share_rows(p_shares) s;
    INSERT INTO public.ledger_share_parts (entry_id, group_id, member_id, payer_member_id, owed_cents)
    SELECT p_entry_id, p_group_id, s.member_id, o.key::UUID, (o.value #>> '{}')::BIGINT
    FROM private.share_rows(p_shares) s, jsonb_each(s.owed_to) o;
END;
$$;

-- Writes a bill and replaces all of its shares, at p_version. p_is_new: entry.create (a plain insert, so
-- an id already in use fails) rather than an update, which also restores a deleted bill. 006 adds the
-- version history.
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
END;
$$;

-- A soft delete: the shares stay, so the bill can be restored, and balances skip deleted bills.
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
-- Bills
-- =============================================================================

CREATE OR REPLACE FUNCTION private.apply_entry_create(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
BEGIN
    v_me := private.require(p_user, v_group_id, 'entry.create');
    PERFORM private.validate_entry(v_group_id, p_mutation);

    PERFORM private.save_entry(
        (p_mutation->>'entryId')::UUID, v_group_id, p_mutation, v_me.id, private.next_group_version(v_group_id), TRUE
    );
END;
$$;

-- =============================================================================
-- Payments: the handshake
-- =============================================================================

-- The two sides of a payment: who paid it back (from) and who received it (to).
CREATE OR REPLACE FUNCTION private.payment_sides(p_entry_id UUID, OUT from_member_id UUID, OUT to_member_id UUID)
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT
        (SELECT s.member_id FROM public.ledger_shares s WHERE s.entry_id = p_entry_id AND s.paid_cents > 0),
        (SELECT s.member_id FROM public.ledger_shares s WHERE s.entry_id = p_entry_id AND s.owed_cents > 0);
$$;

-- Who can answer a handshake: someone still in the group with a login. A name-only person, a deleted
-- account and someone who left can't push to the group, so they could never answer.
CREATE OR REPLACE FUNCTION private.can_answer(p_member public.group_members)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT p_member.user_id IS NOT NULL AND p_member.deleted_at IS NULL;
$$;

-- Undoes the pending payments a member is one side of, at p_version: when they leave, are removed, or
-- delete their account (008), nobody would be left to answer them.
CREATE OR REPLACE FUNCTION private.undo_pending_payments(p_member_id UUID, p_version BIGINT)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
    UPDATE public.ledger_entries e
    SET payment_status = 'undone', closed_at = NOW(),
        updated_by_member_id = p_member_id, updated_at = NOW(), row_version = p_version
    WHERE e.payment_status = 'pending'
        AND EXISTS (SELECT 1 FROM public.ledger_shares s WHERE s.entry_id = e.id AND s.member_id = p_member_id);
END;
$$;

-- A payment is recorded by one side ("I paid Sam", or "Alex paid me"), which counts as that side
-- agreeing; the other side then confirms or declines. When the other side can't answer (private.can_answer),
-- or neither side can (then any full member records it), there is no one to ask, so it counts at once. A
-- pair has at most one pending payment at a time (HS409).
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

-- The pending payment an answer is about, and the side the caller is on. Returns NULL when the server
-- never stored it (its record was rejected), so the answer is accepted and does nothing.
CREATE OR REPLACE FUNCTION private.pending_payment(p_group_id UUID, p_entry_id UUID)
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
        RAISE EXCEPTION 'That payment is in another group' USING ERRCODE = 'HS422';
    END IF;
    IF v_entry.kind <> 'payment' THEN
        RAISE EXCEPTION 'That is a bill, not a payment' USING ERRCODE = 'HS422';
    END IF;
    IF v_entry.payment_status <> 'pending' THEN
        RAISE EXCEPTION 'This payment is already %', v_entry.payment_status USING ERRCODE = 'HS409';
    END IF;
    RETURN v_entry;
END;
$$;

-- Confirm or decline: only the side that hasn't agreed yet may answer.
CREATE OR REPLACE FUNCTION private.answer_payment(p_user UUID, p_mutation JSONB, p_confirm BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_entry public.ledger_entries;
    v_sides RECORD;
    v_as_payer BOOLEAN;
    v_version BIGINT;
BEGIN
    v_me := private.require(p_user, v_group_id, 'payment.respond');
    v_entry := private.pending_payment(v_group_id, (p_mutation->>'entryId')::UUID);
    IF v_entry.id IS NULL THEN
        RETURN;
    END IF;

    SELECT * INTO v_sides FROM private.payment_sides(v_entry.id);
    IF v_me.id = v_sides.from_member_id AND v_entry.payer_confirmed_at IS NULL THEN
        v_as_payer := TRUE;
    ELSIF v_me.id = v_sides.to_member_id AND v_entry.receiver_confirmed_at IS NULL THEN
        v_as_payer := FALSE;
    ELSE
        RAISE EXCEPTION 'Only the other side of this payment can answer it' USING ERRCODE = 'HS403';
    END IF;
    IF NOT p_confirm AND p_mutation->>'note' IS NOT NULL
        AND (jsonb_typeof(p_mutation->'note') <> 'string' OR char_length(p_mutation->>'note') > 200) THEN
        RAISE EXCEPTION 'A note must be text of at most 200 characters' USING ERRCODE = 'HS422';
    END IF;

    v_version := private.next_group_version(v_group_id);
    IF p_confirm THEN
        UPDATE public.ledger_entries
        SET payment_status = 'confirmed',
            payer_confirmed_at = CASE WHEN v_as_payer THEN NOW() ELSE payer_confirmed_at END,
            receiver_confirmed_at = CASE WHEN v_as_payer THEN receiver_confirmed_at ELSE NOW() END,
            confirmed_at = NOW(),
            updated_by_member_id = v_me.id, updated_at = NOW(), row_version = v_version
        WHERE id = v_entry.id;
    ELSE
        UPDATE public.ledger_entries
        SET payment_status = 'declined', closed_at = NOW(), close_note = NULLIF(btrim(p_mutation->>'note'), ''),
            updated_by_member_id = v_me.id, updated_at = NOW(), row_version = v_version
        WHERE id = v_entry.id;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.apply_payment_confirm(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE sql SET search_path = ''
AS $$
    SELECT private.answer_payment(p_user, p_mutation, TRUE);
$$;

CREATE OR REPLACE FUNCTION private.apply_payment_decline(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE sql SET search_path = ''
AS $$
    SELECT private.answer_payment(p_user, p_mutation, FALSE);
$$;

-- Only whoever recorded it may undo it, while it waits.
CREATE OR REPLACE FUNCTION private.apply_payment_undo(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_entry public.ledger_entries;
BEGIN
    v_me := private.require(p_user, v_group_id, 'payment.undo');
    v_entry := private.pending_payment(v_group_id, (p_mutation->>'entryId')::UUID);
    IF v_entry.id IS NULL THEN
        RETURN;
    END IF;
    IF v_entry.created_by_member_id <> v_me.id THEN
        RAISE EXCEPTION 'Only whoever recorded this payment can undo it' USING ERRCODE = 'HS403';
    END IF;

    UPDATE public.ledger_entries
    SET payment_status = 'undone', closed_at = NOW(),
        updated_by_member_id = v_me.id, updated_at = NOW(), row_version = private.next_group_version(v_group_id)
    WHERE id = v_entry.id;
END;
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated;
