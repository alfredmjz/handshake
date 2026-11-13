-- ============================================================================
-- pgTAP tests for payments (migration 005, spec decision 17): the handshake through push_changes().
-- One side records a payment (payment.record), the other confirms or declines it, and the starter can
-- undo it while it waits. Only confirmed payments count; a payment with a name-only person is confirmed
-- when recorded. Everything is rolled back.
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


-- A payment.record: p_from paid p_to back p_amount.
CREATE FUNCTION pg_temp.pay(p_entry UUID, p_from UUID, p_to UUID, p_amount INT, p_group UUID DEFAULT '10000000-0000-0000-0000-000000000001') RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('type', 'payment.record', 'groupId', p_group, 'entryId', p_entry,
        'fromMemberId', p_from, 'toMemberId', p_to, 'amountCents', p_amount, 'entryDate', '2026-11-04', 'notes', NULL);
$$;
CREATE FUNCTION pg_temp.answer(p_type TEXT, p_entry UUID, p_note TEXT DEFAULT NULL) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('type', p_type, 'groupId', '10000000-0000-0000-0000-000000000001', 'entryId', p_entry)
        || CASE WHEN p_note IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('note', p_note) END;
$$;
CREATE FUNCTION pg_temp.payment_now(p_entry UUID)
RETURNS TABLE (status TEXT, payer_agreed BOOLEAN, receiver_agreed BOOLEAN, confirmed BOOLEAN, closed BOOLEAN, note TEXT, version_is_head BOOLEAN)
LANGUAGE sql AS $$
    SELECT e.payment_status, e.payer_confirmed_at IS NOT NULL, e.receiver_confirmed_at IS NOT NULL, e.confirmed_at IS NOT NULL,
        e.closed_at IS NOT NULL, e.close_note, e.row_version = (SELECT head_version FROM public.groups WHERE id = e.group_id)
    FROM public.ledger_entries e WHERE e.id = p_entry;
$$;

-- ---------------------------------------------------------------------------
-- Group 1: Alex (owner), Sam and Jo (members), Kim (a guest), Pat and Max (name-only). Group 2: Lee's.
-- Users: aaaa… Alex, bbbb… Sam, cccc… Jo, dddd… Kim (anonymous), eeee… Lee. Members 2000…<person><group>
-- (Pat f1, Max 91); payments 3000…N.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@payments.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@payments.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'jo@payments.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Jo"}'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'lee@payments.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Lee"}');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Banff", "displayName": "Alex"}'), 'applied', 'Alex creates group 1');
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('type', 'member.add', 'groupId', '10000000-0000-0000-0000-000000000001', 'memberId', p.id, 'displayName', p.name)),
    'applied',
    'Alex adds ' || p.name
)
FROM (VALUES ('20000000-0000-0000-0000-0000000000b1', 'Sam'), ('20000000-0000-0000-0000-0000000000c1', 'Jo'), ('20000000-0000-0000-0000-0000000000d1', 'Kim'),
             ('20000000-0000-0000-0000-0000000000f1', 'Pat'), ('20000000-0000-0000-0000-000000000091', 'Max')) AS p(id, name);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000001", "token": "paymentstestinvitetoken00000000000000000001"}'), 'applied', 'Alex makes a link');
SELECT is(pg_temp.join(j.who, 'paymentstestinvitetoken00000000000000000001', j.claim), '10000000-0000-0000-0000-000000000001'::UUID, j.name || ' joins')
FROM (VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::UUID, '20000000-0000-0000-0000-0000000000b1'::UUID, 'Sam'),
             ('cccccccc-cccc-cccc-cccc-cccccccccccc', '20000000-0000-0000-0000-0000000000c1', 'Jo'),
             ('dddddddd-dddd-dddd-dddd-dddddddddddd', '20000000-0000-0000-0000-0000000000d1', 'Kim')) AS j(who, claim, name);
SELECT is(pg_temp.try('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000e2", "name": "Lee''s", "displayName": "Lee"}'), 'applied', 'Lee creates group 2');

-- ---------------------------------------------------------------------------
-- The handshake: one side records, the other confirms
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.pay('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000a1', 3000)),
    'applied',
    'Sam records "I paid Alex $30.00"'
);
SELECT results_eq(
    $$ SELECT * FROM pg_temp.payment_now('30000000-0000-0000-0000-000000000001') $$,
    $$ VALUES ('pending', TRUE, FALSE, FALSE, FALSE, NULL::TEXT, TRUE) $$,
    'it waits for Alex: pending, with Sam''s (the payer''s) side agreed, stamped with the next version'
);
SELECT results_eq(
    $$ SELECT kind, description, items, amount_cents, created_by_member_id::TEXT FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000001' $$,
    $$ VALUES ('payment', 'Payment', NULL::JSONB, 3000::BIGINT, '20000000-0000-0000-0000-0000000000b1') $$,
    'it is a payment called "Payment", with no items, started by Sam'
);
SELECT is(
    (SELECT e->'shares' FROM jsonb_array_elements(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')#>'{changes,0,entries}') e WHERE e->>'id' = '30000000-0000-0000-0000-000000000001'),
    '[{"member_id": "20000000-0000-0000-0000-0000000000a1", "paid_cents": 0, "owed_cents": 3000, "owed_to": {"20000000-0000-0000-0000-0000000000b1": 3000}},
      {"member_id": "20000000-0000-0000-0000-0000000000b1", "paid_cents": 3000, "owed_cents": 0, "owed_to": {}}]'::JSONB,
    'its shares are built from the sides: Sam paid 3000, Alex "owes" it back to Sam'
);
SELECT is(
    (SELECT e->>'payment_status' FROM jsonb_array_elements(pg_temp.pull('cccccccc-cccc-cccc-cccc-cccccccccccc')#>'{changes,0,entries}') e WHERE e->>'id' = '30000000-0000-0000-0000-000000000001'),
    'pending',
    'the pending row syncs to the whole group (screens show it to the two of them only)'
);

SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.pay('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000a1', 3000)),
    'HS409',
    'a second payment between the same two while one waits is refused (a double tap)'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.pay('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b1', 500)),
    'HS409',
    '... the other way round too'
);
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.answer('payment.confirm', '30000000-0000-0000-0000-000000000001')), 'HS403', 'the starter can''t confirm their own payment');
SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.answer('payment.confirm', '30000000-0000-0000-0000-000000000001')), 'HS403', 'nor can someone who isn''t one of the two');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.answer('payment.undo', '30000000-0000-0000-0000-000000000001')), 'HS403', 'only the starter can undo it');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.answer('payment.confirm', '30000000-0000-0000-0000-000000000001')), 'applied', 'Alex confirms');
SELECT results_eq(
    $$ SELECT * FROM pg_temp.payment_now('30000000-0000-0000-0000-000000000001') $$,
    $$ VALUES ('confirmed', TRUE, TRUE, TRUE, FALSE, NULL::TEXT, TRUE) $$,
    'now it counts: confirmed, both sides agreed, at the next version'
);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.answer('payment.decline', '30000000-0000-0000-0000-000000000001')), 'HS409', 'a second answer is refused: it is no longer pending');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.answer('payment.undo', '30000000-0000-0000-0000-000000000001')), 'HS409', '... and so is undoing it');
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "entry.update", "groupId": "10000000-0000-0000-0000-000000000001", "entryId": "30000000-0000-0000-0000-000000000001", "baseVersion": 0,
        "description": "Payment", "amountCents": 2000, "entryDate": "2026-11-04", "notes": null, "items": [{"amountCents": 2000, "paidBy": "20000000-0000-0000-0000-0000000000b1", "splitAmong": ["20000000-0000-0000-0000-0000000000a1"]}],
        "shares": [{"memberId": "20000000-0000-0000-0000-0000000000a1", "paidCents": 0, "owedCents": 2000, "owedTo": {"20000000-0000-0000-0000-0000000000b1": 2000}}, {"memberId": "20000000-0000-0000-0000-0000000000b1", "paidCents": 2000, "owedCents": 0, "owedTo": {}}]}'),
    'HS422',
    'a payment can''t be edited with entry.update'
);
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "entry.delete", "groupId": "10000000-0000-0000-0000-000000000001", "entryId": "30000000-0000-0000-0000-000000000001", "baseVersion": 0}'),
    'HS422',
    '... or deleted with entry.delete'
);

-- ---------------------------------------------------------------------------
-- Decline and undo close a payment without it counting
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.pay('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000c1', 1000)),
    'applied',
    'Sam records "I paid Jo $10.00"'
);
SELECT results_eq(
    $$ SELECT status, payer_agreed, receiver_agreed FROM pg_temp.payment_now('30000000-0000-0000-0000-000000000003') $$,
    $$ VALUES ('pending', TRUE, FALSE) $$,
    'it waits for Jo, with Sam''s (the payer''s) side agreed'
);
SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.answer('payment.decline', '30000000-0000-0000-0000-000000000003', repeat('x', 201))), 'HS422', 'a decline note over 200 characters is refused');
SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.answer('payment.decline', '30000000-0000-0000-0000-000000000003', 'I didn''t get this')), 'applied', 'Jo declines it, with a note');
SELECT results_eq(
    $$ SELECT * FROM pg_temp.payment_now('30000000-0000-0000-0000-000000000003') $$,
    $$ VALUES ('declined', TRUE, FALSE, FALSE, TRUE, 'I didn''t get this', TRUE) $$,
    'it is declined and closed, with the note, and never counted'
);

SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.pay('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000c1', 1000)),
    'applied',
    'once it is closed, Sam can record another payment to Jo'
);
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.answer('payment.undo', '30000000-0000-0000-0000-000000000004')), 'applied', 'Sam, who started it, undoes it');
SELECT results_eq(
    $$ SELECT status, confirmed, closed FROM pg_temp.payment_now('30000000-0000-0000-0000-000000000004') $$,
    $$ VALUES ('undone', FALSE, TRUE) $$,
    'it is undone and closed, never counted'
);
SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.answer('payment.confirm', '30000000-0000-0000-0000-000000000004')), 'HS409', 'confirming an undone payment is refused');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.answer('payment.confirm', '30000000-0000-0000-0000-000000000077')), 'applied', 'answering a payment the server never stored is accepted and does nothing');

-- ---------------------------------------------------------------------------
-- No handshake with a name-only person
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.pay('30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-0000000000f1', 700)),
    'applied',
    'Kim (a guest) records paying Pat, who has no login'
);
SELECT results_eq(
    $$ SELECT * FROM pg_temp.payment_now('30000000-0000-0000-0000-000000000005') $$,
    $$ VALUES ('confirmed', TRUE, FALSE, TRUE, FALSE, NULL::TEXT, TRUE) $$,
    'it counts at once: there is no one to ask'
);
SELECT is(
    pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.pay('30000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-0000000000f1', '20000000-0000-0000-0000-000000000091', 400)),
    'applied',
    'Jo (a member) records Pat paying Max, two name-only people (payment.record.others)'
);
SELECT results_eq(
    $$ SELECT p.status, p.payer_agreed, p.receiver_agreed, p.confirmed, e.created_by_member_id::TEXT
       FROM pg_temp.payment_now('30000000-0000-0000-0000-000000000006') p, public.ledger_entries e WHERE e.id = '30000000-0000-0000-0000-000000000006' $$,
    $$ VALUES ('confirmed', FALSE, FALSE, TRUE, '20000000-0000-0000-0000-0000000000c1') $$,
    'it counts at once, "Recorded by Jo"'
);
SELECT is(
    pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.pay('30000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-0000000000f1', '20000000-0000-0000-0000-000000000091', 100)),
    'HS403',
    'a guest can''t record for two name-only people'
);
SELECT is(
    pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.pay('30000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b1', 100)),
    'HS422',
    'a member can''t record for two people who have logins'
);

-- ---------------------------------------------------------------------------
-- What a payment must be (HS422)
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.pay('30000000-0000-0000-0000-000000000099', t.from_id, t.to_id, t.amount) || t.extra), 'HS422', t.description)
FROM (VALUES
    ('20000000-0000-0000-0000-0000000000b1'::UUID, '20000000-0000-0000-0000-0000000000b1'::UUID, 500, '{}'::JSONB, 'a payment to yourself'),
    ('20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000e2', 500, '{}', 'a payment to someone in another group'),
    ('20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000f1', 0, '{}', 'a zero amount'),
    ('20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000f1', -5, '{}', 'a negative amount'),
    ('20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000f1', 500, '{"amountCents": 12.5}', 'an amount that isn''t whole cents'),
    ('20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000f1', 500, '{"entryDate": "2026-02-30"}', 'a date that doesn''t exist'),
    ('20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000f1', 500, jsonb_build_object('notes', repeat('x', 1001)), 'notes over 1000 characters')
) AS t(from_id, to_id, amount, extra, description);
SELECT is(pg_temp.try('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', pg_temp.pay('30000000-0000-0000-0000-000000000098', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000a1', 500)), 'HS403', 'someone outside the group can''t record in it');

-- ---------------------------------------------------------------------------
-- Someone who leaves can't answer any more: their pending payments are undone, and new ones with them
-- count at once
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.pay('30000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-0000000000a1', 100)),
    'applied',
    'Kim records paying Alex 100, which waits for Alex'
);
SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000d1"}'), 'applied', 'Kim leaves the group');
SELECT results_eq(
    $$ SELECT status, confirmed, closed, version_is_head FROM pg_temp.payment_now('30000000-0000-0000-0000-000000000010') $$,
    $$ VALUES ('undone', FALSE, TRUE, TRUE) $$,
    'leaving undid Kim''s pending payment, closed, in the same version as the leaving'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.pay('30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-0000000000a1', 100)),
    'applied',
    'Alex records "Kim paid me $1.00" after Kim has left'
);
SELECT results_eq(
    $$ SELECT status, payer_agreed, receiver_agreed, confirmed FROM pg_temp.payment_now('30000000-0000-0000-0000-000000000011') $$,
    $$ VALUES ('confirmed', FALSE, TRUE, TRUE) $$,
    'it counts at once: Kim, who left, can''t answer, though Kim still has a login'
);
SELECT is(
    pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.pay('30000000-0000-0000-0000-000000000012', '20000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-0000000000f1', 100)),
    'applied',
    'Jo records Kim (gone) paying Pat (name-only): neither can answer, so payment.record.others applies'
);
SELECT is((SELECT payment_status FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000012'), 'confirmed', '... and it counts at once');

-- ---------------------------------------------------------------------------
-- The receiver settles alone: what they say they received counts without the payer signing
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.pay('30000000-0000-0000-0000-0000000000e9', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000c1', 500)),
    'applied',
    'Jo records "Sam paid me $5.00"'
);
SELECT results_eq(
    $$ SELECT * FROM pg_temp.payment_now('30000000-0000-0000-0000-0000000000e9') $$,
    $$ VALUES ('confirmed', FALSE, TRUE, TRUE, FALSE, NULL::TEXT, TRUE) $$,
    'it counts at once: only the receiver agreed, and Sam (who can answer) was never asked'
);

-- ---------------------------------------------------------------------------
-- In a completed group a pending payment can still be answered, but not recorded anew or undone
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.pay('30000000-0000-0000-0000-000000000008', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000c1', 1000)),
    'applied',
    'Sam records paying Jo $10.00'
);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.complete", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'Alex completes the group while it waits');
SELECT is((SELECT payment_status FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000008'), 'pending', 'completing leaves it pending');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.answer('payment.undo', '30000000-0000-0000-0000-000000000008')), 'HS403', 'it can''t be undone in a completed group');
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.pay('30000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000f1', 100)),
    'HS403',
    'no new payment can be recorded in a completed group'
);
SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.answer('payment.confirm', '30000000-0000-0000-0000-000000000008')), 'applied', 'Jo can still confirm it (payment.respond is allowed when completed)');
SELECT is((SELECT payment_status FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000008'), 'confirmed', 'and it counts');

SELECT * FROM finish();
ROLLBACK;
