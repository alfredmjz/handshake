-- ============================================================================
-- pgTAP tests for the rule helpers. Migration 018: who may record a payment, who must answer it, and the
-- amount, date and notes checks bills and payments share; members are built in place, not stored (can_answer
-- reads only user_id and deleted_at). Migration 020: the checks validate_entry and apply_payment_record call,
-- each with its exact reason, and the order validate_entry runs them in; these use a stored group.
-- Everything is rolled back.
-- ============================================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(88);
\ir prelude.psql

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

-- ---------------------------------------------------------------------------
-- Migration 020. Group 7000…01: Alex (a1, owner) and Sam (b1) have logins, Pat (f1) is name-only, Lee (e1)
-- was removed. Alex has recorded paying Sam 100, which waits for Sam.
-- ---------------------------------------------------------------------------
SELECT pg_temp.add_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@rules.test', 'Alex');
SELECT pg_temp.add_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@rules.test', 'Sam');
SELECT is(pg_temp.try_reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "70000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Rules", "displayName": "Alex"}'), 'applied', 'setup: Alex creates the group');
SELECT is(pg_temp.try_reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "70000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1", "displayName": "Sam"}'), 'applied', 'setup: Alex adds Sam');
SELECT is(pg_temp.try_reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "70000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "Pat"}'), 'applied', 'setup: Alex adds Pat');
SELECT is(pg_temp.try_reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "70000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e1", "displayName": "Lee"}'), 'applied', 'setup: Alex adds Lee');
SELECT is(pg_temp.try_reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.remove", "groupId": "70000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e1"}'), 'applied', 'setup: Alex removes Lee');
SELECT is(pg_temp.join_code('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.code('70000000-0000-0000-0000-000000000001'), '20000000-0000-0000-0000-0000000000b1'), '70000000-0000-0000-0000-000000000001'::UUID, 'setup: Sam joins as himself');
SELECT is(pg_temp.try_reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "payment.record", "groupId": "70000000-0000-0000-0000-000000000001", "entryId": "30000000-0000-0000-0000-000000000001", "fromMemberId": "20000000-0000-0000-0000-0000000000a1", "toMemberId": "20000000-0000-0000-0000-0000000000b1", "amountCents": 100, "entryDate": "2026-11-04", "notes": null}'), 'applied', 'setup: Alex records paying Sam 100');
SELECT is(
    (SELECT string_agg(display_name || CASE WHEN deleted_at IS NULL THEN '' ELSE ' (left)' END || CASE WHEN user_id IS NULL THEN '' ELSE ' (login)' END, ', ' ORDER BY display_name)
        FROM public.group_members WHERE group_id = '70000000-0000-0000-0000-000000000001'),
    'Alex (login), Lee (left), Pat, Sam (login)',
    'the group is as described'
);
SELECT is((SELECT payment_status FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000001'), 'pending', 'Alex''s payment to Sam waits');

-- 900 that Alex paid, split by Alex, Sam and Pat: 300 each, each owed to Alex.
CREATE TEMP TABLE bill AS SELECT '{
    "kind": "expense", "description": "Taxi", "amountCents": 900, "entryDate": "2026-11-05", "notes": null,
    "items": [{"id": "i1", "amountCents": 900, "paidBy": "20000000-0000-0000-0000-0000000000a1",
        "splitAmong": ["20000000-0000-0000-0000-0000000000a1", "20000000-0000-0000-0000-0000000000b1", "20000000-0000-0000-0000-0000000000f1"]}],
    "shares": [
        {"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 900, "owedCents": 300, "owedTo": {"20000000-0000-0000-0000-0000000000a1": 300}},
        {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 0, "owedCents": 300, "owedTo": {"20000000-0000-0000-0000-0000000000a1": 300}},
        {"memberId": "20000000-0000-0000-0000-0000000000f1", "paidCents": 0, "owedCents": 300, "owedTo": {"20000000-0000-0000-0000-0000000000a1": 300}}
    ]
}'::JSONB AS j;

-- ---------------------------------------------------------------------------
-- bill_description: text, 1 to 120 characters after trimming
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.error_of($$ SELECT private.bill_description('{"description": "Taxi"}') $$), 'ok', 'a description');
SELECT is(pg_temp.error_of($$ SELECT private.bill_description(jsonb_build_object('description', repeat('d', 120))) $$), 'ok', '120 characters are fine');
SELECT is(pg_temp.error_of($$ SELECT private.bill_description('{"description": 5}') $$), 'HS422 The description must be text', 'a number is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_description('{}') $$), 'HS422 The description must be text', 'no description is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_description('{"description": "   "}') $$), 'HS422 The description must be 1 to 120 characters', 'a blank one is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_description(jsonb_build_object('description', repeat('d', 121))) $$), 'HS422 The description must be 1 to 120 characters', '121 characters are refused');

-- ---------------------------------------------------------------------------
-- bill_shares: one per person, whole cents, adding up to the amount both ways, owedTo by payer
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.error_of($$ SELECT private.bill_shares(j->'shares', 900) FROM bill $$), 'ok', 'the bill''s shares');
SELECT is(pg_temp.error_of($$ SELECT private.bill_shares('[]', 900) $$), 'HS422 A bill needs its shares', 'no shares are refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_shares(NULL, 900) $$), 'HS422 A bill needs its shares', 'missing shares are refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_shares(jsonb_set(j->'shares', '{1,paidCents}', '-1'), 900) FROM bill $$), 'HS422 Each share needs whole, non-negative paidCents and owedCents, and owedTo by payer', 'a negative paidCents is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_shares(jsonb_set(j->'shares', '{1,owedTo}', '[]'), 900) FROM bill $$), 'HS422 Each share needs whole, non-negative paidCents and owedCents, and owedTo by payer', 'owedTo that isn''t an object is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_shares(jsonb_set(j->'shares', '{1,owedTo,20000000-0000-0000-0000-0000000000a1}', '299.5'), 900) FROM bill $$), 'HS422 Each share needs whole, non-negative paidCents and owedCents, and owedTo by payer', 'half a cent in owedTo is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_shares(jsonb_set(j->'shares', '{2,memberId}', '"20000000-0000-0000-0000-0000000000B1"'), 900) FROM bill $$), 'HS422 Someone appears twice in the shares', 'Sam twice (in another case) is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_shares(j->'shares', 901) FROM bill $$), 'HS422 The shares must add up to the amount', 'shares of 900 on a bill of 901 are refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_shares(jsonb_set(j->'shares', '{0,paidCents}', '800'), 900) FROM bill $$), 'HS422 The shares must add up to the amount', 'paid 800 of 900 is refused');

-- ---------------------------------------------------------------------------
-- bill_items: 1 to 50, each with whole cents and someone to split it once each, adding up to the amount
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.error_of($$ SELECT private.bill_items(j->'items', 900) FROM bill $$), 'ok', 'the bill''s items');
SELECT is(pg_temp.error_of($$ SELECT private.bill_items(NULL, 900) $$), 'HS422 A bill needs 1 to 50 items', 'missing items are refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_items('[]', 900) $$), 'HS422 A bill needs 1 to 50 items', 'no items are refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_items((SELECT jsonb_agg(j->'items'->0 || '{"amountCents": 18}') FROM bill, generate_series(1, 50)), 900) $$), 'ok', '50 items of 18 are fine');
SELECT is(pg_temp.error_of($$ SELECT private.bill_items((SELECT jsonb_agg(j->'items'->0) FROM bill, generate_series(1, 51)), 900) $$), 'HS422 A bill needs 1 to 50 items', '51 items are refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_items(jsonb_set(j->'items', '{0,amountCents}', '0'), 900) FROM bill $$), 'HS422 Each item needs a whole amount of cents from 1 to 10^12', 'an item of 0 is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_items(jsonb_set(j->'items', '{0,description}', to_jsonb(repeat('d', 61))), 900) FROM bill $$), 'HS422 An item''s description must be text of at most 60 characters', 'an item description of 61 characters is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_items(jsonb_set(j->'items', '{0,description}', to_jsonb(repeat('d', 60))), 900) FROM bill $$), 'ok', '... 60 are fine');
SELECT is(pg_temp.error_of($$ SELECT private.bill_items(jsonb_set(j->'items', '{0,splitAmong}', '[]'), 900) FROM bill $$), 'HS422 Each item needs someone to split it', 'an item split by no one is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_items(jsonb_set(j->'items', '{0,splitAmong,2}', '"20000000-0000-0000-0000-0000000000A1"'), 900) FROM bill $$), 'HS422 Someone appears twice in an item''s split', 'Alex twice (in another case) in a split is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_items(j->'items', 901) FROM bill $$), 'HS422 The items must add up to the amount', 'items of 900 on a bill of 901 are refused');

-- ---------------------------------------------------------------------------
-- bill_people_in_group: everyone named is in the group, people who left included
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.error_of($$ SELECT private.bill_people_in_group('70000000-0000-0000-0000-000000000001', j->'shares', j->'items') FROM bill $$), 'ok', 'Alex, Sam and Pat are in the group');
SELECT is(pg_temp.error_of($$ SELECT private.bill_people_in_group('70000000-0000-0000-0000-000000000001', '[{"memberId": "20000000-0000-0000-0000-0000000000E1", "owedTo": {}}]', '[]') $$), 'ok', 'Lee, who was removed, still counts');
SELECT is(pg_temp.error_of($$ SELECT private.bill_people_in_group('70000000-0000-0000-0000-000000000001', jsonb_set(j->'shares', '{2,memberId}', '"20000000-0000-0000-0000-0000000000d1"'), j->'items') FROM bill $$), 'HS422 Everyone in a bill must be in this group', 'a sharer from outside is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_people_in_group('70000000-0000-0000-0000-000000000001', jsonb_set(j->'shares', '{1,owedTo}', '{"20000000-0000-0000-0000-0000000000d1": 300}'), j->'items') FROM bill $$), 'HS422 Everyone in a bill must be in this group', 'owing someone from outside is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_people_in_group('70000000-0000-0000-0000-000000000001', j->'shares', jsonb_set(j->'items', '{0,paidBy}', 'null')) FROM bill $$), 'HS422 Everyone in a bill must be in this group', 'an item paid by no one is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_people_in_group('70000000-0000-0000-0000-000000000001', j->'shares', jsonb_set(j->'items', '{0,splitAmong,2}', '"20000000-0000-0000-0000-0000000000d1"')) FROM bill $$), 'HS422 Everyone in a bill must be in this group', 'a splitter from outside is refused');
SELECT is(pg_temp.error_of($$ SELECT private.bill_people_in_group('70000000-0000-0000-0000-000000000099', j->'shares', j->'items') FROM bill $$), 'HS422 Everyone in a bill must be in this group', 'the same people in another group are refused');

-- ---------------------------------------------------------------------------
-- bill_shares_match_items: the shares are what the items give
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.error_of($$ SELECT private.bill_shares_match_items(j->'shares', j->'items') FROM bill $$), 'ok', '300 each, owed to Alex, is what the item gives');
-- Same totals, but Sam owes 400 and Pat 200 where the item gives 300 each.
SELECT is(pg_temp.error_of($$ SELECT private.bill_shares_match_items(
    jsonb_set(jsonb_set(j->'shares', '{1}', '{"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 0, "owedCents": 400, "owedTo": {"20000000-0000-0000-0000-0000000000a1": 400}}'),
        '{2}', '{"memberId": "20000000-0000-0000-0000-0000000000f1", "paidCents": 0, "owedCents": 200, "owedTo": {"20000000-0000-0000-0000-0000000000a1": 200}}'),
    j->'items') FROM bill $$), 'HS422 The shares don''t match the items', 'shares of 300, 400 and 200 are refused');

-- ---------------------------------------------------------------------------
-- validate_entry: the checks in order (the first that fails is the reason), and malformed values
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.error_of($$ SELECT private.validate_entry('70000000-0000-0000-0000-000000000001', j) FROM bill $$), 'ok', 'the bill passes every check');
SELECT is(pg_temp.error_of($$ SELECT private.validate_entry('70000000-0000-0000-0000-000000000001', j || '{"description": "", "amountCents": 0}') FROM bill $$), 'HS422 The description must be 1 to 120 characters', 'a blank description and an amount of 0: the description is checked first');
SELECT is(pg_temp.error_of($$ SELECT private.validate_entry('70000000-0000-0000-0000-000000000001', j || '{"amountCents": 901}') FROM bill $$), 'HS422 The shares must add up to the amount', 'neither the shares nor the items add up to 901: the shares are checked first');
SELECT is(pg_temp.error_of($$ SELECT private.validate_entry('70000000-0000-0000-0000-000000000001', jsonb_set(jsonb_set(j, '{items,0,amountCents}', '0'), '{shares,2,memberId}', '"20000000-0000-0000-0000-0000000000d1"')) FROM bill $$), 'HS422 Each item needs a whole amount of cents from 1 to 10^12', 'an item of 0 and a sharer from outside: the items are checked first');
SELECT is(pg_temp.error_of($$ SELECT private.validate_entry('70000000-0000-0000-0000-000000000001', j || '{"entryDate": "2026-02-30"}') FROM bill $$), 'HS422 The entry has a malformed value: date/time field value out of range: "2026-02-30"', 'a day that doesn''t exist is a malformed value');

-- ---------------------------------------------------------------------------
-- payment_sides: both in the group, two different people
-- ---------------------------------------------------------------------------
SELECT is(
    (SELECT ARRAY[(s.from_member).id, (s.to_member).id] FROM private.payment_sides('70000000-0000-0000-0000-000000000001',
        '{"fromMemberId": "20000000-0000-0000-0000-0000000000F1", "toMemberId": "20000000-0000-0000-0000-0000000000e1"}') s),
    ARRAY['20000000-0000-0000-0000-0000000000f1', '20000000-0000-0000-0000-0000000000e1']::UUID[],
    'Pat to Lee (who was removed): both rows, payer first'
);
SELECT is(pg_temp.error_of($$ SELECT private.payment_sides('70000000-0000-0000-0000-000000000001', '{"fromMemberId": "20000000-0000-0000-0000-0000000000d1", "toMemberId": "20000000-0000-0000-0000-0000000000a1"}') $$), 'HS422 Both sides of a payment must be in this group', 'a payer from outside is refused');
SELECT is(pg_temp.error_of($$ SELECT private.payment_sides('70000000-0000-0000-0000-000000000001', '{"fromMemberId": "20000000-0000-0000-0000-0000000000a1"}') $$), 'HS422 Both sides of a payment must be in this group', 'no receiver is refused');
SELECT is(pg_temp.error_of($$ SELECT private.payment_sides('70000000-0000-0000-0000-000000000001', '{"fromMemberId": "20000000-0000-0000-0000-0000000000a1", "toMemberId": "20000000-0000-0000-0000-0000000000A1"}') $$), 'HS422 A payment is between two different people', 'Alex paying Alex is refused');

-- ---------------------------------------------------------------------------
-- no_payment_waiting: one waiting payment between two people at a time, either way round
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.error_of($$ SELECT private.no_payment_waiting('70000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b1') $$), 'HS409 A payment between these two is already waiting for an answer', 'Alex to Sam again is refused');
SELECT is(pg_temp.error_of($$ SELECT private.no_payment_waiting('70000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000a1') $$), 'HS409 A payment between these two is already waiting for an answer', 'Sam to Alex is refused too');
SELECT is(pg_temp.error_of($$ SELECT private.no_payment_waiting('70000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000f1') $$), 'ok', 'Alex to Pat is fine');

SELECT is(
    ARRAY(SELECT p.proname::TEXT FROM pg_proc p
        WHERE p.pronamespace = 'private'::regnamespace
            AND p.proname IN ('bill_description', 'bill_shares', 'bill_items', 'bill_people_in_group', 'bill_shares_match_items', 'payment_sides', 'no_payment_waiting')
            AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
        ORDER BY 1),
    '{}'::TEXT[],
    'signed-in and signed-out callers may call none of migration 020''s helpers'
);

SELECT * FROM finish();
ROLLBACK;
