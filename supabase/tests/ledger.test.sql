-- ============================================================================
-- pgTAP tests for entries (migration 005): entry.create, entry.update and entry.delete through
-- push_changes(), every entry check the server makes (HS422), who may do what (HS403), and entries with
-- their shares in pull_changes(). The rounding itself is pinned in ledger_cases.test.sql; here the
-- server must accept shares that match it and refuse shares one cent off. Everything is rolled back.
-- ============================================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

-- ---------------------------------------------------------------------------
-- Helpers: act as a signed-in user (a guest when their auth user is anonymous)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.sign_in(p_user UUID) RETURNS VOID LANGUAGE sql AS $$
    SELECT set_config('request.jwt.claims', json_build_object(
        'sub', p_user,
        'role', 'authenticated',
        'is_anonymous', COALESCE((SELECT is_anonymous FROM auth.users WHERE id = p_user), FALSE)
    )::TEXT, true);
$$;
CREATE FUNCTION pg_temp.push_signed_in(p_mutations JSONB) RETURNS JSONB LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.push_changes(p_mutations);
$$;
CREATE FUNCTION pg_temp.pull_signed_in(p_cursors JSONB) RETURNS JSONB LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.pull_changes(p_cursors);
$$;
CREATE FUNCTION pg_temp.join_signed_in(p_token TEXT, p_claim UUID, p_name TEXT) RETURNS UUID LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.join_group(p_token, p_claim, p_name);
$$;
CREATE FUNCTION pg_temp.push(p_user UUID, p_mutation JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.push_signed_in(jsonb_build_array(jsonb_build_object('id', gen_random_uuid()) || p_mutation));
END $$;
-- 'applied', or the rejection's code.
CREATE FUNCTION pg_temp.try(p_user UUID, p_mutation JSONB) RETURNS TEXT LANGUAGE sql AS $$
    SELECT COALESCE(r#>>'{rejected,0,code}', 'applied') FROM pg_temp.push(p_user, p_mutation) r;
$$;
CREATE FUNCTION pg_temp.reason(p_user UUID, p_mutation JSONB) RETURNS TEXT LANGUAGE sql AS $$
    SELECT r#>>'{rejected,0,reason}' FROM pg_temp.push(p_user, p_mutation) r;
$$;
CREATE FUNCTION pg_temp.pull(p_user UUID, p_cursors JSONB DEFAULT '{}') RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.pull_signed_in(p_cursors);
END $$;
CREATE FUNCTION pg_temp.join(p_user UUID, p_token TEXT, p_claim UUID DEFAULT NULL, p_name TEXT DEFAULT NULL) RETURNS UUID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.join_signed_in(p_token, p_claim, p_name);
END $$;
CREATE FUNCTION pg_temp.head(p_group UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT head_version FROM public.groups WHERE id = p_group;
$$;
CREATE FUNCTION pg_temp.version_of(p_entry UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT row_version FROM public.ledger_entries WHERE id = p_entry;
$$;

-- The $10 dinner: Sam paid 1000, split by Alex, Jo and Sam → Alex 333, Jo 333, Sam 334 (Sam, the payer,
-- covers the cent; pinned in the case table).
CREATE FUNCTION pg_temp.dinner(p_entry UUID) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'type', 'entry.create',
        'groupId', '10000000-0000-0000-0000-000000000001',
        'entryId', p_entry,
        'kind', 'expense',
        'description', 'Dinner',
        'amountCents', 1000,
        'entryDate', '2026-11-02',
        'notes', NULL,
        'recordedVia', NULL,
        'items', '[{"id": "i1", "description": "Pizza", "amountCents": 1000, "paidBy": "20000000-0000-0000-0000-0000000000b1",
                    "splitAmong": ["20000000-0000-0000-0000-0000000000a1", "20000000-0000-0000-0000-0000000000c1", "20000000-0000-0000-0000-0000000000b1"]}]'::JSONB,
        'shares', '[{"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 333},
                    {"memberId": "20000000-0000-0000-0000-0000000000c1", "paidCents": 0, "owedCents": 333},
                    {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 1000, "owedCents": 334}]'::JSONB
    );
$$;

-- Jo pays Sam back 333.
CREATE FUNCTION pg_temp.payment(p_entry UUID) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'type', 'entry.create',
        'groupId', '10000000-0000-0000-0000-000000000001',
        'entryId', p_entry,
        'kind', 'payment',
        'amountCents', 333,
        'entryDate', '2026-11-03',
        'notes', NULL,
        'items', NULL,
        'recordedVia', NULL,
        'shares', '[{"memberId": "20000000-0000-0000-0000-0000000000c1", "paidCents": 333, "owedCents": 0},
                    {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 0, "owedCents": 333}]'::JSONB
    );
$$;

-- ---------------------------------------------------------------------------
-- Group 1: Alex (owner), Sam and Jo (members), Kim (a guest), Pat (not joined).
-- Group 2: Lee's. Ids: users aaaa… Alex, bbbb… Sam, cccc… Jo, dddd… Kim, eeee… Lee; members
-- 2000…<person><group>; entries 3000…N.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@ledger.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@ledger.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'jo@ledger.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Jo"}'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'lee@ledger.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Lee"}');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Banff", "displayName": "Alex"}'), 'applied', 'Alex creates group 1');
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('type', 'member.add', 'groupId', '10000000-0000-0000-0000-000000000001', 'memberId', p.id, 'displayName', p.name)),
    'applied',
    'Alex adds ' || p.name
)
FROM (VALUES ('20000000-0000-0000-0000-0000000000b1', 'Sam'), ('20000000-0000-0000-0000-0000000000c1', 'Jo'),
             ('20000000-0000-0000-0000-0000000000d1', 'Kim'), ('20000000-0000-0000-0000-0000000000f1', 'Pat')) AS p(id, name);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000001", "token": "ledgertestinvitetoken0000000000000000000001"}'), 'applied', 'Alex makes a link');
SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'ledgertestinvitetoken0000000000000000000001', '20000000-0000-0000-0000-0000000000b1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam joins');
SELECT is(pg_temp.join('cccccccc-cccc-cccc-cccc-cccccccccccc', 'ledgertestinvitetoken0000000000000000000001', '20000000-0000-0000-0000-0000000000c1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Jo joins');
SELECT is(pg_temp.join('dddddddd-dddd-dddd-dddd-dddddddddddd', 'ledgertestinvitetoken0000000000000000000001', '20000000-0000-0000-0000-0000000000d1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Kim joins as a guest');
SELECT is(pg_temp.try('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000e2", "name": "Lee''s", "displayName": "Lee"}'), 'applied', 'Lee creates group 2');

-- ---------------------------------------------------------------------------
-- Creating: shares must be exactly what compute_shares gives for the items
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.dinner('30000000-0000-0000-0000-000000000001')), 'applied', 'the $10 dinner with Alex 333, Jo 333, Sam 334 is accepted');

SELECT results_eq(
    $$ SELECT kind, description, amount_cents, entry_date, notes, recorded_via, created_by_member_id::TEXT, updated_by_member_id::TEXT, deleted_at, row_version
       FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000001' $$,
    $$ VALUES ('expense', 'Dinner', 1000::BIGINT, '2026-11-02'::DATE, NULL::TEXT, NULL::TEXT, '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000b1', NULL::TIMESTAMPTZ,
               (SELECT head_version FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001')) $$,
    'the entry is stored as sent, added and last changed by Sam''s member row, at the group''s newest version'
);

SELECT results_eq(
    $$ SELECT member_id::TEXT, paid_cents, owed_cents FROM public.ledger_shares WHERE entry_id = '30000000-0000-0000-0000-000000000001' ORDER BY member_id $$,
    $$ VALUES ('20000000-0000-0000-0000-0000000000a1', 0::BIGINT, 333::BIGINT), ('20000000-0000-0000-0000-0000000000b1', 1000::BIGINT, 334::BIGINT),
              ('20000000-0000-0000-0000-0000000000c1', 0::BIGINT, 333::BIGINT) $$,
    'its three shares are stored'
);

SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.dinner('30000000-0000-0000-0000-000000000002') || '{"shares": [
        {"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 334},
        {"memberId": "20000000-0000-0000-0000-0000000000c1", "paidCents": 0, "owedCents": 333},
        {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 1000, "owedCents": 333}]}'),
    'HS422',
    'shares one cent off (Alex 334, Sam 333) are refused, though they still add up'
);
SELECT is(
    pg_temp.reason('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.dinner('30000000-0000-0000-0000-000000000002') || '{"shares": [
        {"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 334},
        {"memberId": "20000000-0000-0000-0000-0000000000c1", "paidCents": 0, "owedCents": 333},
        {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 1000, "owedCents": 333}]}'),
    'The shares don''t match the items',
    '... because they differ from the items'
);

-- ---------------------------------------------------------------------------
-- Every other entry check (HS422)
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.dinner('30000000-0000-0000-0000-000000000099') || t.change), 'HS422', t.description)
FROM (VALUES
    ('{"shares": [{"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 333}, {"memberId": "20000000-0000-0000-0000-0000000000c1", "paidCents": 0, "owedCents": 333}, {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 1000, "owedCents": 333}]}'::JSONB,
     'shares that owe 999 of 1000 don''t add up'),
    ('{"shares": [{"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 333}, {"memberId": "20000000-0000-0000-0000-0000000000c1", "paidCents": 0, "owedCents": 333}, {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 999, "owedCents": 334}]}',
     'shares that paid 999 of 1000 don''t add up'),
    ('{"items": [{"amountCents": 900, "paidBy": "20000000-0000-0000-0000-0000000000b1", "splitAmong": ["20000000-0000-0000-0000-0000000000a1", "20000000-0000-0000-0000-0000000000c1", "20000000-0000-0000-0000-0000000000b1"]}]}',
     'items of 900 don''t add up to the total of 1000'),
    ('{"items": [{"amountCents": 1000, "paidBy": "20000000-0000-0000-0000-0000000000b1", "splitAmong": ["20000000-0000-0000-0000-0000000000a1", "20000000-0000-0000-0000-0000000000e2"]}],
       "shares": [{"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 500}, {"memberId": "20000000-0000-0000-0000-0000000000e2", "paidCents": 0, "owedCents": 500}, {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 1000, "owedCents": 0}]}',
     'a member of another group (Lee) can''t be in the bill'),
    ('{"items": [{"amountCents": 1000, "paidBy": "20000000-0000-0000-0000-0000000000e2", "splitAmong": ["20000000-0000-0000-0000-0000000000a1"]}],
       "shares": [{"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 1000}, {"memberId": "20000000-0000-0000-0000-0000000000e2", "paidCents": 1000, "owedCents": 0}]}',
     'a member of another group can''t be the payer'),
    ('{"items": [{"amountCents": 1000, "paidBy": "20000000-0000-0000-0000-0000000000b1", "splitAmong": ["alex"]}],
       "shares": [{"memberId": "alex", "paidCents": 0, "owedCents": 1000}, {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 1000, "owedCents": 0}]}',
     'a member id that isn''t an id at all'),
    ('{"shares": [{"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 333}, {"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 333}, {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 1000, "owedCents": 334}]}',
     'someone twice in the shares'),
    ('{"items": [{"amountCents": 1000, "paidBy": "20000000-0000-0000-0000-0000000000b1", "splitAmong": ["20000000-0000-0000-0000-0000000000a1", "20000000-0000-0000-0000-0000000000a1", "20000000-0000-0000-0000-0000000000b1"]}]}',
     'someone twice in an item''s split'),
    ('{"amountCents": 0}', 'a zero amount'),
    ('{"amountCents": -1000}', 'a negative amount'),
    ('{"amountCents": 1000.5}', 'an amount that isn''t whole cents'),
    ('{"amountCents": "1000"}', 'an amount sent as text'),
    ('{"amountCents": 1000000000001}', 'an amount over 10^12'),
    ('{"items": []}', 'an expense with no items'),
    ('{"items": null}', 'an expense with items left out'),
    ('{"items": [{"amountCents": 1000, "paidBy": "20000000-0000-0000-0000-0000000000b1", "splitAmong": []}]}', 'an item with nobody to split it'),
    ('{"items": [{"amountCents": 0, "paidBy": "20000000-0000-0000-0000-0000000000b1", "splitAmong": ["20000000-0000-0000-0000-0000000000b1"]}]}', 'an item of zero'),
    (jsonb_build_object('items', jsonb_build_array(jsonb_build_object(
        'description', repeat('x', 61), 'amountCents', 1000, 'paidBy', '20000000-0000-0000-0000-0000000000b1',
        'splitAmong', '["20000000-0000-0000-0000-0000000000a1", "20000000-0000-0000-0000-0000000000c1", "20000000-0000-0000-0000-0000000000b1"]'::JSONB))),
     'an item description over 60 characters'),
    (jsonb_build_object('items', (SELECT jsonb_agg('{"amountCents": 20, "paidBy": "20000000-0000-0000-0000-0000000000b1", "splitAmong": ["20000000-0000-0000-0000-0000000000b1"]}'::JSONB) FROM generate_series(1, 51)),
                        'amountCents', 1020,
                        'shares', '[{"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 1020, "owedCents": 1020}]'::JSONB),
     'a bill of 51 items'),
    ('{"description": "   "}', 'a blank description'),
    (jsonb_build_object('description', repeat('x', 121)), 'a description over 120 characters'),
    (jsonb_build_object('notes', repeat('x', 1001)), 'notes over 1000 characters'),
    ('{"entryDate": "2026-02-30"}', 'a date that doesn''t exist'),
    ('{"entryDate": "02/11/2026"}', 'a date not in YYYY-MM-DD'),
    ('{"kind": "refund"}', 'a kind other than expense or payment'),
    ('{"shares": []}', 'no shares at all'),
    ('{"shares": [{"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": -1}, {"memberId": "20000000-0000-0000-0000-0000000000c1", "paidCents": 0, "owedCents": 667}, {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 1000, "owedCents": 334}]}',
     'a negative share')
) AS t(change, description);

SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.payment('30000000-0000-0000-0000-000000000099') || t.change), 'HS422', t.description)
FROM (VALUES
    ('{"shares": [{"memberId": "20000000-0000-0000-0000-0000000000c1", "paidCents": 333, "owedCents": 0}, {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 0, "owedCents": 233}, {"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 100}]}'::JSONB,
     'a payment to two people'),
    ('{"shares": [{"memberId": "20000000-0000-0000-0000-0000000000c1", "paidCents": 333, "owedCents": 333}]}', 'a payment to yourself'),
    ('{"shares": [{"memberId": "20000000-0000-0000-0000-0000000000c1", "paidCents": 333, "owedCents": 100}, {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 0, "owedCents": 233}]}',
     'a payment where the payer also owes part'),
    ('{"items": [{"amountCents": 333, "paidBy": "20000000-0000-0000-0000-0000000000c1", "splitAmong": ["20000000-0000-0000-0000-0000000000b1"]}]}', 'a payment with items')
) AS t(change, description);

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.payment('30000000-0000-0000-0000-000000000099') || '{"recordedVia": "magic"}'), 'HS422', 'a recordedVia other than settle_up, even from the owner');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.dinner('30000000-0000-0000-0000-000000000099') || '{"recordedVia": "settle_up"}'), 'HS422', 'settle_up on an expense');

SELECT is(pg_temp.try('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', pg_temp.dinner('30000000-0000-0000-0000-000000000098')), 'HS403', 'someone outside the group (Lee) can''t add to it');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.payment('30000000-0000-0000-0000-000000000098') || '{"recordedVia": "settle_up"}'), 'HS403', 'only the owner records from the settle-up tracker');
SELECT is((SELECT count(*)::INT FROM public.ledger_entries), 1, 'none of the refused entries were stored');

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.payment('30000000-0000-0000-0000-000000000002')), 'applied', 'Jo records paying Sam back 333');
SELECT results_eq(
    $$ SELECT kind, description, items, recorded_via FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000002' $$,
    $$ VALUES ('payment', 'Payment', NULL::JSONB, NULL::TEXT) $$,
    'a payment without a description is called "Payment" and has no items'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.payment('30000000-0000-0000-0000-000000000003') || '{"recordedVia": "settle_up", "description": "Settled up"}'),
    'applied',
    'the owner records a settle-up payment'
);

-- ---------------------------------------------------------------------------
-- Updating: owner and members; shares are replaced whole
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.dinner('30000000-0000-0000-0000-000000000001') || jsonb_build_object(
        'type', 'entry.update',
        'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000001'),
        'description', 'Dinner (Jo left early)',
        'items', '[{"id": "i1", "amountCents": 1000, "paidBy": "20000000-0000-0000-0000-0000000000b1", "splitAmong": ["20000000-0000-0000-0000-0000000000a1", "20000000-0000-0000-0000-0000000000b1"]}]'::JSONB,
        'shares', '[{"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 500}, {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 1000, "owedCents": 500}]'::JSONB
    )),
    'applied',
    'a member edits the dinner: now split by Alex and Sam only'
);
SELECT results_eq(
    $$ SELECT member_id::TEXT, paid_cents, owed_cents FROM public.ledger_shares WHERE entry_id = '30000000-0000-0000-0000-000000000001' ORDER BY member_id $$,
    $$ VALUES ('20000000-0000-0000-0000-0000000000a1', 0::BIGINT, 500::BIGINT), ('20000000-0000-0000-0000-0000000000b1', 1000::BIGINT, 500::BIGINT) $$,
    'the shares are replaced, not merged: Jo''s share is gone'
);
SELECT results_eq(
    $$ SELECT description, updated_by_member_id::TEXT, created_by_member_id::TEXT, row_version = (SELECT head_version FROM public.groups WHERE id = group_id)
       FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000001' $$,
    $$ VALUES ('Dinner (Jo left early)', '20000000-0000-0000-0000-0000000000c1', '20000000-0000-0000-0000-0000000000b1', TRUE) $$,
    'the edit records who changed it, keeps who added it, and takes the next version'
);

SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.payment('30000000-0000-0000-0000-000000000003') || jsonb_build_object(
        'type', 'entry.update', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000003'), 'notes', 'Cash')),
    'applied',
    'a member can edit a settle-up payment'
);
SELECT results_eq(
    $$ SELECT notes, recorded_via FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000003' $$,
    $$ VALUES ('Cash', 'settle_up') $$,
    '... which stays a settle-up payment: an update keeps recordedVia'
);

SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.payment('30000000-0000-0000-0000-000000000001') || jsonb_build_object('type', 'entry.update', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000001'))),
    'HS422',
    'an update can''t turn an expense into a payment'
);
SELECT is(
    pg_temp.try('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', pg_temp.dinner('30000000-0000-0000-0000-000000000001') || '{"type": "entry.update", "groupId": "10000000-0000-0000-0000-000000000002", "baseVersion": 0}'),
    'HS422',
    'an update can''t reach an entry of another group through your own group'
);
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.dinner('30000000-0000-0000-0000-000000000001') || '{"type": "entry.update"}'),
    'HS422',
    'an update must say which version it started from'
);

-- ---------------------------------------------------------------------------
-- Changes to an entry the server never stored are accepted and do nothing
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.dinner('30000000-0000-0000-0000-000000000077') || '{"type": "entry.update", "baseVersion": 0}'), 'applied', 'updating an entry whose create was rejected is accepted');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "entry.delete", "groupId": "10000000-0000-0000-0000-000000000001", "entryId": "30000000-0000-0000-0000-000000000077", "baseVersion": 0}'), 'applied', '... and so is deleting it');
SELECT is((SELECT count(*)::INT FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000077'), 0, '... and neither stored anything');

-- ---------------------------------------------------------------------------
-- Guests: add entries, delete only their own, never edit
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.payment('30000000-0000-0000-0000-000000000004') || '{"shares": [
        {"memberId": "20000000-0000-0000-0000-0000000000d1", "paidCents": 333, "owedCents": 0}, {"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 333}]}'),
    'applied',
    'a guest adds an entry'
);
SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.payment('30000000-0000-0000-0000-000000000004') || '{"type": "entry.update", "baseVersion": 99, "notes": "x"}'), 'HS403', 'a guest can''t edit, even their own');
SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', '{"type": "entry.delete", "groupId": "10000000-0000-0000-0000-000000000001", "entryId": "30000000-0000-0000-0000-000000000002", "baseVersion": 99}'), 'HS403', 'a guest can''t delete someone else''s entry');
SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', jsonb_build_object('type', 'entry.delete', 'groupId', '10000000-0000-0000-0000-000000000001', 'entryId', '30000000-0000-0000-0000-000000000004', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000004'))), 'applied', 'a guest deletes their own entry');

-- ---------------------------------------------------------------------------
-- Deleting is soft, and deleted entries reach other devices
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('type', 'entry.delete', 'groupId', '10000000-0000-0000-0000-000000000001', 'entryId', '30000000-0000-0000-0000-000000000002', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000002'))), 'applied', 'the owner deletes Jo''s payment');
SELECT results_eq(
    $$ SELECT deleted_at IS NOT NULL, updated_by_member_id::TEXT, (SELECT count(*)::INT FROM public.ledger_shares WHERE entry_id = e.id)
       FROM public.ledger_entries e WHERE id = '30000000-0000-0000-0000-000000000002' $$,
    $$ VALUES (TRUE, '20000000-0000-0000-0000-0000000000a1', 2) $$,
    'the row stays with deleted_at and its shares, changed by the owner'
);
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "entry.delete", "groupId": "10000000-0000-0000-0000-000000000001", "entryId": "30000000-0000-0000-0000-000000000002", "baseVersion": 1}'), 'applied', 'deleting it again from another device is accepted');

SELECT ok(
    (SELECT e->>'deleted_at' IS NOT NULL
     FROM jsonb_array_elements(pg_temp.pull('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')#>'{changes,0,entries}') e
     WHERE e->>'id' = '30000000-0000-0000-0000-000000000002'),
    'a deleted entry is pulled with deleted_at set'
);

-- ---------------------------------------------------------------------------
-- What a pulled entry looks like (the keys wire.ts reads)
-- ---------------------------------------------------------------------------
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_array_elements(pg_temp.pull('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')#>'{changes,0,entries}') e, jsonb_object_keys(e) k
     WHERE e->>'id' = '30000000-0000-0000-0000-000000000001'),
    ARRAY['amount_cents', 'created_at', 'created_by_member_id', 'deleted_at', 'description', 'entry_date', 'group_id', 'id', 'items',
          'kind', 'notes', 'recorded_via', 'row_version', 'shares', 'updated_at', 'updated_by_member_id'],
    'a pulled entry has exactly these keys'
);
SELECT is(
    (SELECT e->'shares' FROM jsonb_array_elements(pg_temp.pull('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')#>'{changes,0,entries}') e
     WHERE e->>'id' = '30000000-0000-0000-0000-000000000001'),
    '[{"member_id": "20000000-0000-0000-0000-0000000000a1", "paid_cents": 0, "owed_cents": 500},
      {"member_id": "20000000-0000-0000-0000-0000000000b1", "paid_cents": 1000, "owed_cents": 500}]'::JSONB,
    'it carries all of its shares, by member id, with exactly member_id, paid_cents and owed_cents'
);
SELECT is(
    (SELECT e->'items'->0->>'id' FROM jsonb_array_elements(pg_temp.pull('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')#>'{changes,0,entries}') e
     WHERE e->>'id' = '30000000-0000-0000-0000-000000000001'),
    'i1',
    'its items come back as the device wrote them (camelCase JSON)'
);
SELECT is(
    jsonb_array_length(pg_temp.pull('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.version_of('30000000-0000-0000-0000-000000000001')))#>'{changes,0,entries}'),
    3,
    'a pull past the dinner''s version returns only what changed after it: the settle-up payment edit, the guest''s deleted entry and Jo''s deleted payment'
);
SELECT is(
    pg_temp.pull('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')->'changes' @> '[{"entries": [{"id": "30000000-0000-0000-0000-000000000001"}]}]'::JSONB,
    FALSE,
    'someone outside the group never pulls its entries'
);

SELECT * FROM finish();
ROLLBACK;
