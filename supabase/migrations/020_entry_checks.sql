-- ============================================================================
-- Migration 020: bills and payments as lists of named checks
--
-- private.validate_entry and private.apply_payment_record are restated, for the last time, as a list of
-- calls: each check now lives in its own private helper, and a later change to a check replaces only that
-- helper. Nothing a caller sees changes: the same checks, in the same order, with the same codes and reasons.
-- Safe to re-run.
-- ============================================================================

-- =============================================================================
-- Bills
-- =============================================================================

-- The description: text, 1 to 120 characters after trimming.
CREATE OR REPLACE FUNCTION private.bill_description(p_entry JSONB)
RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
    IF jsonb_typeof(p_entry->'description') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'The description must be text' USING ERRCODE = 'HS422';
    END IF;
    IF char_length(btrim(p_entry->>'description')) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'The description must be 1 to 120 characters' USING ERRCODE = 'HS422';
    END IF;
END;
$$;

-- Shares: one per person, whole cents, adding up to the amount both ways, each split by payer.
CREATE OR REPLACE FUNCTION private.bill_shares(p_shares JSONB, p_amount NUMERIC)
RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
    IF jsonb_typeof(p_shares) IS DISTINCT FROM 'array' OR jsonb_array_length(p_shares) = 0 THEN
        RAISE EXCEPTION 'A bill needs its shares' USING ERRCODE = 'HS422';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_shares) s
        WHERE NOT private.is_cents(s->'paidCents', 0) OR NOT private.is_cents(s->'owedCents', 0)
            OR jsonb_typeof(s->'owedTo') IS DISTINCT FROM 'object'
            OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(s->'owedTo') = 'object' THEN s->'owedTo' ELSE '{}' END) o
                WHERE NOT private.is_cents(o.value, 0))
    ) THEN
        RAISE EXCEPTION 'Each share needs whole, non-negative paidCents and owedCents, and owedTo by payer' USING ERRCODE = 'HS422';
    END IF;
    IF (SELECT count(DISTINCT lower(s->>'memberId')) <> count(*) FROM jsonb_array_elements(p_shares) s) THEN
        RAISE EXCEPTION 'Someone appears twice in the shares' USING ERRCODE = 'HS422';
    END IF;
    IF (SELECT sum((s->>'paidCents')::NUMERIC) <> p_amount OR sum((s->>'owedCents')::NUMERIC) <> p_amount
        FROM jsonb_array_elements(p_shares) s) THEN
        RAISE EXCEPTION 'The shares must add up to the amount' USING ERRCODE = 'HS422';
    END IF;
END;
$$;

-- Items: 1 to 50, each with whole cents and someone to split it, adding up to the amount.
CREATE OR REPLACE FUNCTION private.bill_items(p_items JSONB, p_amount NUMERIC)
RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
    v_items JSONB := COALESCE(p_items, 'null'::JSONB);
    v_item JSONB;
BEGIN
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
    IF (SELECT sum((i->>'amountCents')::NUMERIC) FROM jsonb_array_elements(v_items) i) <> p_amount THEN
        RAISE EXCEPTION 'The items must add up to the amount' USING ERRCODE = 'HS422';
    END IF;
END;
$$;

-- Everyone a bill names (sharers, payers owed, item payers and splitters) is in this group, members who left
-- included. The shares and items must already have passed their checks.
CREATE OR REPLACE FUNCTION private.bill_people_in_group(p_group_id UUID, p_shares JSONB, p_items JSONB)
RETURNS VOID
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM (
            SELECT s->>'memberId' FROM jsonb_array_elements(p_shares) s
            UNION ALL
            SELECT o.key FROM jsonb_array_elements(p_shares) s, jsonb_object_keys(s->'owedTo') o(key)
            UNION ALL
            SELECT i->>'paidBy' FROM jsonb_array_elements(p_items) i
            UNION ALL
            SELECT p #>> '{}' FROM jsonb_array_elements(p_items) i, jsonb_array_elements(i->'splitAmong') p
        ) AS named(person)
        WHERE person IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.group_members gm WHERE gm.group_id = p_group_id AND gm.id::TEXT = lower(person)
        )
    ) THEN
        RAISE EXCEPTION 'Everyone in a bill must be in this group' USING ERRCODE = 'HS422';
    END IF;
END;
$$;

-- The shares are exactly what the items give (private.compute_shares). The shares and items must already have
-- passed their checks.
CREATE OR REPLACE FUNCTION private.bill_shares_match_items(p_shares JSONB, p_items JSONB)
RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
    IF EXISTS (
        (SELECT * FROM private.compute_shares(p_items) EXCEPT SELECT * FROM private.share_rows(p_shares))
        UNION ALL
        (SELECT * FROM private.share_rows(p_shares) EXCEPT SELECT * FROM private.compute_shares(p_items))
    ) THEN
        RAISE EXCEPTION 'The shares don''t match the items' USING ERRCODE = 'HS422';
    END IF;
END;
$$;

-- As in 018, as a list of checks.
CREATE OR REPLACE FUNCTION private.validate_entry(p_group_id UUID, p_entry JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_kind TEXT := COALESCE(p_entry->>'kind', 'expense');
    v_amount NUMERIC;
BEGIN
    IF v_kind = 'payment' THEN
        RAISE EXCEPTION 'Payments are recorded with payment.record' USING ERRCODE = 'HS422';
    END IF;
    IF v_kind <> 'expense' THEN
        RAISE EXCEPTION 'An entry is a bill (expense) or a payment' USING ERRCODE = 'HS422';
    END IF;
    PERFORM private.bill_description(p_entry);
    v_amount := private.entry_amount(p_entry);
    PERFORM private.entry_date(p_entry);
    PERFORM private.entry_notes(p_entry);
    PERFORM private.bill_shares(p_entry->'shares', v_amount);
    PERFORM private.bill_items(p_entry->'items', v_amount);
    PERFORM private.bill_people_in_group(p_group_id, p_entry->'shares', p_entry->'items');
    PERFORM private.bill_shares_match_items(p_entry->'shares', p_entry->'items');
EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'The entry has a malformed value: %', SQLERRM USING ERRCODE = 'HS422';
END;
$$;

-- =============================================================================
-- Payments
-- =============================================================================

-- The two sides, from fromMemberId and toMemberId: both in this group (members who left included), and two
-- different people.
CREATE OR REPLACE FUNCTION private.payment_sides(
    p_group_id UUID,
    p_mutation JSONB,
    OUT from_member public.group_members,
    OUT to_member public.group_members
)
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
    SELECT * INTO from_member FROM public.group_members WHERE group_id = p_group_id AND id::TEXT = lower(p_mutation->>'fromMemberId');
    SELECT * INTO to_member FROM public.group_members WHERE group_id = p_group_id AND id::TEXT = lower(p_mutation->>'toMemberId');
    IF from_member.id IS NULL OR to_member.id IS NULL THEN
        RAISE EXCEPTION 'Both sides of a payment must be in this group' USING ERRCODE = 'HS422';
    END IF;
    IF from_member.id = to_member.id THEN
        RAISE EXCEPTION 'A payment is between two different people' USING ERRCODE = 'HS422';
    END IF;
END;
$$;

-- At most one payment between two people waits for an answer at a time, whichever way it goes.
CREATE OR REPLACE FUNCTION private.no_payment_waiting(p_group_id UUID, p_a UUID, p_b UUID)
RETURNS VOID
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.ledger_entries e
        WHERE e.group_id = p_group_id AND e.payment_status = 'pending'
            AND (SELECT count(*) FROM public.ledger_shares s WHERE s.entry_id = e.id AND s.member_id IN (p_a, p_b)) = 2
    ) THEN
        RAISE EXCEPTION 'A payment between these two is already waiting for an answer' USING ERRCODE = 'HS409';
    END IF;
END;
$$;

-- As in 018, as a list of checks, then the writes.
CREATE OR REPLACE FUNCTION private.apply_payment_record(p_user UUID, p_mutation JSONB)
RETURNS VOID
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_group_id UUID := (p_mutation->>'groupId')::UUID;
    v_me public.group_members;
    v_sides RECORD;
    v_from public.group_members;
    v_to public.group_members;
    v_amount BIGINT;
    v_date DATE;
    v_answerer UUID;
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
    v_sides := private.payment_sides(v_group_id, p_mutation);
    v_from := v_sides.from_member;
    v_to := v_sides.to_member;
    IF NOT private.may_record_payment(v_me.id, v_from, v_to) THEN
        RAISE EXCEPTION 'You can only record payments between two people who can''t answer them themselves' USING ERRCODE = 'HS422';
    END IF;
    v_amount := private.entry_amount(p_mutation)::BIGINT;
    BEGIN
        v_date := private.entry_date(p_mutation);
    EXCEPTION WHEN data_exception THEN
        RAISE EXCEPTION 'The date must be a real day' USING ERRCODE = 'HS422';
    END;
    PERFORM private.entry_notes(p_mutation);
    IF char_length(private.entry_description(p_mutation || '{"kind": "payment"}')) > 120 THEN
        RAISE EXCEPTION 'The description must be at most 120 characters' USING ERRCODE = 'HS422';
    END IF;
    PERFORM private.no_payment_waiting(v_group_id, v_from.id, v_to.id);

    v_answerer := private.payment_answerer(v_me.id, v_from, v_to);
    v_version := private.next_group_version(v_group_id);

    INSERT INTO public.ledger_entries (
        id, group_id, kind, description, amount_cents, entry_date, notes,
        payment_status, payer_confirmed_at, receiver_confirmed_at, confirmed_at,
        created_by_member_id, updated_by_member_id, row_version
    )
    VALUES (
        v_entry_id, v_group_id, 'payment', private.entry_description(p_mutation || '{"kind": "payment"}'),
        v_amount, v_date, p_mutation->>'notes',
        CASE WHEN v_answerer IS NULL THEN 'confirmed' ELSE 'pending' END,
        CASE WHEN v_me.id = v_from.id THEN NOW() END,
        CASE WHEN v_me.id = v_to.id THEN NOW() END,
        CASE WHEN v_answerer IS NULL THEN NOW() END,
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

REVOKE EXECUTE ON FUNCTION private.bill_description(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.bill_shares(JSONB, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.bill_items(JSONB, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.bill_people_in_group(UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.bill_shares_match_items(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.payment_sides(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.no_payment_waiting(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
