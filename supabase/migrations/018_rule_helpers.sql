-- Rule helpers: the rules that change on their own, named in small private functions, and the big functions
-- redefined once more to call them. Nothing a caller sees changes: the same checks, in the same order, with
-- the same codes and reasons. Safe to re-run.
--
-- - Who must answer a payment, and who may record one between two other people (apply_payment_record).
-- - The amount, date and notes checks that bills (validate_entry) and payments (apply_payment_record) share.

-- =============================================================================
-- Payments: who records, who answers
-- =============================================================================

-- Someone may record a payment they are one side of. They may record one between two other people only when
-- neither of those two can answer it themselves (both name-only, or gone).
CREATE OR REPLACE FUNCTION private.may_record_payment(
    p_recorder_id UUID,
    p_from public.group_members,
    p_to public.group_members
)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT p_recorder_id IN (p_from.id, p_to.id) OR NOT (private.can_answer(p_from) OR private.can_answer(p_to));
$$;

-- Who must answer a payment before it counts: the receiver, when the payer recorded it and the receiver can
-- answer. NULL when it counts at once (the receiver recorded it, or nobody else could answer).
CREATE OR REPLACE FUNCTION private.payment_answerer(
    p_recorder_id UUID,
    p_from public.group_members,
    p_to public.group_members
)
RETURNS UUID
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT CASE WHEN p_recorder_id = p_from.id AND private.can_answer(p_to) THEN p_to.id END;
$$;

-- =============================================================================
-- Fields bills and payments share
-- =============================================================================

-- The amount: a whole number of cents from 1 to 10^12.
CREATE OR REPLACE FUNCTION private.entry_amount(p_entry JSONB)
RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
    IF NOT private.is_cents(p_entry->'amountCents', 1) THEN
        RAISE EXCEPTION 'The amount must be a whole number of cents from 1 to 10^12' USING ERRCODE = 'HS422';
    END IF;
    RETURN (p_entry->>'amountCents')::NUMERIC;
END;
$$;

-- The date, written YYYY-MM-DD. A day that doesn't exist ("2026-02-30") raises the cast's data_exception;
-- bills and payments word that differently.
CREATE OR REPLACE FUNCTION private.entry_date(p_entry JSONB)
RETURNS DATE
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
    IF COALESCE(p_entry->>'entryDate', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'The date must be YYYY-MM-DD' USING ERRCODE = 'HS422';
    END IF;
    RETURN (p_entry->>'entryDate')::DATE;
END;
$$;

-- The notes: none, or text of at most 1000 characters.
CREATE OR REPLACE FUNCTION private.entry_notes(p_entry JSONB)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
BEGIN
    IF p_entry->>'notes' IS NOT NULL AND (jsonb_typeof(p_entry->'notes') <> 'string' OR char_length(p_entry->>'notes') > 1000) THEN
        RAISE EXCEPTION 'Notes must be text of at most 1000 characters' USING ERRCODE = 'HS422';
    END IF;
    RETURN p_entry->>'notes';
END;
$$;

-- =============================================================================
-- The big functions, calling the helpers
-- =============================================================================

-- As in 005, with the amount, date and notes checks from the helpers.
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
    v_amount := private.entry_amount(p_entry);
    PERFORM private.entry_date(p_entry);
    PERFORM private.entry_notes(p_entry);

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

-- As in 014, with who may record it, who must answer it, and the shared field checks from the helpers.
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

    SELECT * INTO v_from FROM public.group_members WHERE group_id = v_group_id AND id::TEXT = lower(p_mutation->>'fromMemberId');
    SELECT * INTO v_to FROM public.group_members WHERE group_id = v_group_id AND id::TEXT = lower(p_mutation->>'toMemberId');
    IF v_from.id IS NULL OR v_to.id IS NULL THEN
        RAISE EXCEPTION 'Both sides of a payment must be in this group' USING ERRCODE = 'HS422';
    END IF;
    IF v_from.id = v_to.id THEN
        RAISE EXCEPTION 'A payment is between two different people' USING ERRCODE = 'HS422';
    END IF;
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

    IF EXISTS (
        SELECT 1 FROM public.ledger_entries e
        WHERE e.group_id = v_group_id AND e.payment_status = 'pending'
            AND (SELECT count(*) FROM public.ledger_shares s WHERE s.entry_id = e.id AND s.member_id IN (v_from.id, v_to.id)) = 2
    ) THEN
        RAISE EXCEPTION 'A payment between these two is already waiting for an answer' USING ERRCODE = 'HS409';
    END IF;

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

REVOKE EXECUTE ON FUNCTION private.may_record_payment(UUID, public.group_members, public.group_members) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.payment_answerer(UUID, public.group_members, public.group_members) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.entry_amount(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.entry_date(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION private.entry_notes(JSONB) FROM PUBLIC, anon, authenticated;
