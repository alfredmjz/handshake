-- The receiver settles alone: when the person who is owed records a payment, it counts at once. The payer does
-- not have to confirm money someone else says they received. A payment the payer records still waits for the
-- receiver, as before (spec decision 17).

-- As in 010, except who has to answer.
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

    -- Only the person paying needs the other side to agree. The receiver saying they were paid is enough.
    v_other_can_answer := CASE
        WHEN v_me.id = v_from.id THEN private.can_answer(v_to)
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
