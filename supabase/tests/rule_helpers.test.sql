-- ============================================================================
-- pgTAP tests for the rule helpers (migration 018): who may record a payment, who must answer it, and the
-- amount, date and notes checks bills and payments share. Members are built in place, not stored: can_answer
-- reads only user_id and deleted_at. Everything is rolled back.
-- ============================================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(31);

-- A member: p_login FALSE is a name-only person, p_left TRUE someone who left.
CREATE FUNCTION pg_temp.member(p_id UUID, p_login BOOLEAN, p_left BOOLEAN DEFAULT FALSE) RETURNS public.group_members LANGUAGE sql AS $$
    SELECT jsonb_populate_record(NULL::public.group_members, jsonb_build_object(
        'id', p_id,
        'user_id', CASE WHEN p_login THEN 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' END,
        'deleted_at', CASE WHEN p_left THEN '2026-11-01T00:00:00Z' END
    ));
$$;
-- 'ok', or the error's SQLSTATE and message.
CREATE FUNCTION pg_temp.error_of(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE p_sql;
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE || ' ' || SQLERRM;
END $$;

-- Alex (a1) and Sam (b1) have logins, Pat (f1) and Max (91) are name-only, Lee (e1) has left. Jo (c1) records.
CREATE TEMP TABLE people AS SELECT
    pg_temp.member('20000000-0000-0000-0000-0000000000a1', TRUE) AS alex,
    pg_temp.member('20000000-0000-0000-0000-0000000000b1', TRUE) AS sam,
    pg_temp.member('20000000-0000-0000-0000-0000000000f1', FALSE) AS pat,
    pg_temp.member('20000000-0000-0000-0000-000000000091', FALSE) AS max,
    pg_temp.member('20000000-0000-0000-0000-0000000000e1', TRUE, TRUE) AS lee,
    '20000000-0000-0000-0000-0000000000c1'::UUID AS jo;

-- ---------------------------------------------------------------------------
-- may_record_payment: either side may; someone else only between two who can't answer
-- ---------------------------------------------------------------------------
SELECT is((SELECT private.may_record_payment((alex).id, alex, sam) FROM people), TRUE, 'the payer may record it');
SELECT is((SELECT private.may_record_payment((sam).id, alex, sam) FROM people), TRUE, 'the receiver may record it');
SELECT is((SELECT private.may_record_payment(jo, pat, max) FROM people), TRUE, 'Jo may record one between two name-only people');
SELECT is((SELECT private.may_record_payment(jo, pat, lee) FROM people), TRUE, '... or between a name-only person and someone who left');
SELECT is((SELECT private.may_record_payment(jo, alex, pat) FROM people), FALSE, 'not when the payer can answer');
SELECT is((SELECT private.may_record_payment(jo, pat, sam) FROM people), FALSE, 'not when the receiver can answer');
SELECT is((SELECT private.may_record_payment(jo, alex, sam) FROM people), FALSE, 'not when both can');

-- ---------------------------------------------------------------------------
-- payment_answerer: the receiver, only when the payer records it and the receiver can answer
-- ---------------------------------------------------------------------------
SELECT is((SELECT private.payment_answerer((alex).id, alex, sam) FROM people), '20000000-0000-0000-0000-0000000000b1'::UUID, 'Alex records paying Sam: Sam must answer');
SELECT is((SELECT private.payment_answerer((sam).id, alex, sam) FROM people), NULL, 'Sam records being paid by Alex: it counts at once');
SELECT is((SELECT private.payment_answerer((alex).id, alex, pat) FROM people), NULL, 'Alex records paying Pat (name-only): nobody can answer, it counts at once');
SELECT is((SELECT private.payment_answerer((alex).id, alex, lee) FROM people), NULL, 'Alex records paying Lee, who left: it counts at once');
SELECT is((SELECT private.payment_answerer(jo, pat, max) FROM people), NULL, 'Jo records Pat paying Max: it counts at once');

-- ---------------------------------------------------------------------------
-- entry_amount: a whole number of cents from 1 to 10^12, as a JSON number
-- ---------------------------------------------------------------------------
SELECT is(private.entry_amount('{"amountCents": 1}'), 1::NUMERIC, '1 cent');
SELECT is(private.entry_amount('{"amountCents": 1000000000000}'), 1000000000000::NUMERIC, '10^12 cents');
SELECT is(private.entry_amount('{"amountCents": 250.0}'), 250::NUMERIC, '250.0 is a whole number');
SELECT is(pg_temp.error_of($$ SELECT private.entry_amount('{"amountCents": 0}') $$), 'HS422 The amount must be a whole number of cents from 1 to 10^12', '0 is refused');
SELECT is(pg_temp.error_of($$ SELECT private.entry_amount('{"amountCents": 1000000000001}') $$), 'HS422 The amount must be a whole number of cents from 1 to 10^12', '10^12 + 1 is refused');
SELECT is(pg_temp.error_of($$ SELECT private.entry_amount('{"amountCents": 12.5}') $$), 'HS422 The amount must be a whole number of cents from 1 to 10^12', 'half a cent is refused');
SELECT is(pg_temp.error_of($$ SELECT private.entry_amount('{"amountCents": "100"}') $$), 'HS422 The amount must be a whole number of cents from 1 to 10^12', 'a string is refused');
SELECT is(pg_temp.error_of($$ SELECT private.entry_amount('{}') $$), 'HS422 The amount must be a whole number of cents from 1 to 10^12', 'no amount is refused');

-- ---------------------------------------------------------------------------
-- entry_date: YYYY-MM-DD; a day that doesn't exist raises the cast's error (22008)
-- ---------------------------------------------------------------------------
SELECT is(private.entry_date('{"entryDate": "2026-11-04"}'), '2026-11-04'::DATE, '2026-11-04');
SELECT is(private.entry_date('{"entryDate": "2028-02-29"}'), '2028-02-29'::DATE, '29 February in a leap year');
SELECT is(pg_temp.error_of($$ SELECT private.entry_date('{"entryDate": "2026-11-4"}') $$), 'HS422 The date must be YYYY-MM-DD', 'a one-digit day is refused');
SELECT is(pg_temp.error_of($$ SELECT private.entry_date('{"entryDate": "04/11/2026"}') $$), 'HS422 The date must be YYYY-MM-DD', 'another format is refused');
SELECT is(pg_temp.error_of($$ SELECT private.entry_date('{}') $$), 'HS422 The date must be YYYY-MM-DD', 'no date is refused');
SELECT is(left(pg_temp.error_of($$ SELECT private.entry_date('{"entryDate": "2026-02-30"}') $$), 6), '22008 ', '30 February has the shape, but the cast refuses it');

-- ---------------------------------------------------------------------------
-- entry_notes: none, or text of at most 1000 characters
-- ---------------------------------------------------------------------------
SELECT is(private.entry_notes('{"notes": null}'), NULL, 'null is no notes');
SELECT is(private.entry_notes(jsonb_build_object('notes', repeat('n', 1000))), repeat('n', 1000), '1000 characters are fine');
SELECT is(pg_temp.error_of($$ SELECT private.entry_notes(jsonb_build_object('notes', repeat('n', 1001))) $$), 'HS422 Notes must be text of at most 1000 characters', '1001 are refused');
SELECT is(pg_temp.error_of($$ SELECT private.entry_notes('{"notes": 5}') $$), 'HS422 Notes must be text of at most 1000 characters', 'a number is refused');

-- ---------------------------------------------------------------------------
-- Private: nobody but the server calls them
-- ---------------------------------------------------------------------------
SELECT is(
    ARRAY(SELECT p.proname::TEXT FROM pg_proc p
        WHERE p.pronamespace = 'private'::regnamespace
            AND p.proname IN ('may_record_payment', 'payment_answerer', 'entry_amount', 'entry_date', 'entry_notes')
            AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
        ORDER BY 1),
    '{}'::TEXT[],
    'signed-in and signed-out callers may call none of the helpers'
);

SELECT * FROM finish();
ROLLBACK;
