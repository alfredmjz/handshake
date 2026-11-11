-- ============================================================================
-- pgTAP tests for nudges (migration 011): the person owed reminds someone who owes them, once per 24 hours
-- per pair, carrying the debt at that moment. Owners, members and guests may; a name-only person, yourself
-- or someone outside the group can't be nudged; a completed group refuses it. Everything goes through
-- push_changes() and pull_changes() and is rolled back.
-- ============================================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

-- ---------------------------------------------------------------------------
-- Helpers: act as a signed-in user
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
CREATE FUNCTION pg_temp.visible_nudges_signed_in() RETURNS BIGINT LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT count(*) FROM public.nudges;
$$;
CREATE FUNCTION pg_temp.insert_nudge_signed_in() RETURNS VOID LANGUAGE sql SET role = 'authenticated' AS $$
    INSERT INTO public.nudges (id, group_id, from_member_id, to_member_id, amount_cents)
    VALUES (gen_random_uuid(), '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b1', 1);
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
-- The rejection's reason, or 'applied'.
CREATE FUNCTION pg_temp.reason(p_user UUID, p_mutation JSONB) RETURNS TEXT LANGUAGE sql AS $$
    SELECT COALESCE(r#>>'{rejected,0,reason}', 'applied') FROM pg_temp.push(p_user, p_mutation) r;
$$;
CREATE FUNCTION pg_temp.pull(p_user UUID, p_cursors JSONB DEFAULT '{}') RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.pull_signed_in(p_cursors);
END $$;
CREATE FUNCTION pg_temp.join(p_user UUID, p_token TEXT, p_claim UUID) RETURNS UUID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.join_signed_in(p_token, p_claim, NULL);
END $$;
CREATE FUNCTION pg_temp.visible_nudges(p_user UUID) RETURNS BIGINT LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.visible_nudges_signed_in();
END $$;

-- A bill in group 1 that p_payer paid in full, split evenly among p_among (p_amount divides evenly).
CREATE FUNCTION pg_temp.bill(p_entry UUID, p_payer UUID, p_among UUID[], p_amount INT) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'type', 'entry.create',
        'groupId', '10000000-0000-0000-0000-000000000001',
        'entryId', p_entry,
        'description', 'Dinner',
        'amountCents', p_amount,
        'entryDate', '2026-11-02',
        'notes', NULL,
        'items', jsonb_build_array(jsonb_build_object('id', 'i1', 'amountCents', p_amount, 'paidBy', p_payer, 'splitAmong', to_jsonb(p_among))),
        'shares', (
            SELECT jsonb_agg(jsonb_build_object(
                'memberId', m,
                'paidCents', CASE WHEN m = p_payer THEN p_amount ELSE 0 END,
                'owedCents', p_amount / cardinality(p_among),
                'owedTo', jsonb_build_object(p_payer::TEXT, p_amount / cardinality(p_among))
            ))
            FROM unnest(p_among) m
        )
    );
$$;

CREATE FUNCTION pg_temp.nudge(p_nudge UUID, p_to UUID, p_amount JSONB, p_group UUID DEFAULT '10000000-0000-0000-0000-000000000001') RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('type', 'nudge.send', 'groupId', p_group, 'nudgeId', p_nudge, 'toMemberId', p_to, 'amountCents', p_amount);
$$;

-- Moves every nudge from p_from to p_to back by p_hours.
CREATE FUNCTION pg_temp.backdate(p_from UUID, p_to UUID, p_hours INT) RETURNS VOID LANGUAGE sql AS $$
    UPDATE public.nudges SET created_at = created_at - make_interval(hours => p_hours)
    WHERE from_member_id = p_from AND to_member_id = p_to;
$$;

-- ---------------------------------------------------------------------------
-- Group 1: Alex (owner), Sam (member), Gus (guest), Jo (name-only).
-- Users: aaaa… Alex, bbbb… Sam, dddd… Gus (anonymous), cccc… Pat (not in group 1).
-- Members 2000…a1 Alex, …b1 Sam, …d1 Gus, …e1 Jo; group 2's 2000…a2 Alex, …f2 Lee. Nudges 6000…N.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@nudges.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@nudges.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'pat@nudges.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Pat"}'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Lisbon", "displayName": "Alex"}'), 'applied', 'Alex creates group 1');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1", "displayName": "Sam"}'), 'applied', 'Alex adds Sam');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000d1", "displayName": "Gus"}'), 'applied', 'Alex adds Gus');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e1", "displayName": "Jo"}'), 'applied', 'Alex adds Jo by name');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000001", "token": "nudgestestinvitetoken0000000000000000000001"}'), 'applied', 'Alex makes a link');
SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'nudgestestinvitetoken0000000000000000000001', '20000000-0000-0000-0000-0000000000b1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam joins');
SELECT is(pg_temp.join('dddddddd-dddd-dddd-dddd-dddddddddddd', 'nudgestestinvitetoken0000000000000000000001', '20000000-0000-0000-0000-0000000000d1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Gus joins as a guest');
SELECT is((SELECT role FROM public.group_members WHERE id = '20000000-0000-0000-0000-0000000000d1'), 'guest', 'Gus is a guest');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000a2", "name": "Other", "displayName": "Alex"}'), 'applied', 'Alex creates group 2');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000f2", "displayName": "Lee"}'), 'applied', 'Alex adds Lee to group 2');

-- Bill 1: Alex paid 900 for Alex, Sam, Jo: Sam and Jo owe Alex 300 each.
-- Bill 2: Sam paid 400 for Sam, Gus: Gus owes Sam 200.
-- Bill 3: Gus paid 600 for Gus, Alex, Jo: Alex and Jo owe Gus 200 each.
-- Debts: Sam→Alex 300, Jo→Alex 300, Gus→Sam 200, Alex→Gus 200, Jo→Gus 200.
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.bill('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a1', ARRAY['20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000e1']::UUID[], 900)), 'applied', 'bill 1');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.bill('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000b1', ARRAY['20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000d1']::UUID[], 400)), 'applied', 'bill 2');
SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.bill('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000d1', ARRAY['20000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000e1']::UUID[], 600)), 'applied', 'bill 3');

SELECT is(private.debt_between('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000a1'), 300::BIGINT, 'debt_between: Sam owes Alex 300');
SELECT is(private.debt_between('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b1'), -300::BIGINT, '... and Alex owes Sam -300');
SELECT is(private.debt_between('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000d1'), 200::BIGINT, '... Alex owes Gus 200');

-- ---------------------------------------------------------------------------
-- Allowed: owner, member and guest, each nudging someone who owes them
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000b1', '300')), 'applied', 'the owner nudges Sam, who owes them');
SELECT results_eq(
    $$ SELECT group_id, from_member_id, to_member_id, amount_cents, row_version = (SELECT head_version FROM public.groups WHERE id = n.group_id)
       FROM public.nudges n WHERE id = '60000000-0000-0000-0000-000000000001' $$,
    $$ VALUES ('10000000-0000-0000-0000-000000000001'::UUID, '20000000-0000-0000-0000-0000000000a1'::UUID, '20000000-0000-0000-0000-0000000000b1'::UUID, 300::BIGINT, TRUE) $$,
    '... stored from Alex to Sam with the amount, at the group''s newest version'
);
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.nudge('60000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000d1', '200')), 'applied', 'a member nudges Gus, who owes them');
SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.nudge('60000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000a1', '200')), 'applied', 'a guest nudges Alex, who owes them');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000b1', '300')), 'applied', 'the same nudge again under a new mutation id is accepted');
SELECT is((SELECT count(*) FROM public.nudges WHERE from_member_id = '20000000-0000-0000-0000-0000000000a1'), 1::BIGINT, '... and stores nothing more');

-- ---------------------------------------------------------------------------
-- Refused
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000d1', '200')), 'HS422', 'Alex can''t nudge Gus: Alex owes Gus');
SELECT is(pg_temp.reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000d1', '200')), 'Gus doesn''t owe you anything', '... with that reason');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000a1', '300')), 'HS422', 'Sam can''t nudge Alex: Sam owes Alex');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000e1', '300')), 'HS422', 'a name-only person can''t be nudged, though Jo owes Alex');
SELECT is(pg_temp.reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000e1', '300')), 'Jo hasn''t joined', '... with that reason');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000a1', '300')), 'HS422', 'you can''t nudge yourself');
SELECT is(pg_temp.reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000a1', '300')), 'You can''t nudge yourself', '... with that reason');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000f2', '300')), 'HS422', 'someone from another group can''t be nudged here');
SELECT is(pg_temp.reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000f2', '300')), 'That person is not in this group', '... with that reason');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000b1', '0')), 'HS422', 'an amount of 0 is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000b1', '1.5')), 'HS422', 'an amount that isn''t whole cents is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000b1', '"300"')), 'HS422', 'an amount that isn''t a number is refused');
SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000b1', '300')), 'HS403', 'someone outside the group can''t nudge');

-- ---------------------------------------------------------------------------
-- Once per 24 hours per pair
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-0000000000b1', '300')), 'HS409', 'a second nudge to Sam the same day is refused');
SELECT is(pg_temp.reason('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-0000000000b1', '300')), 'You nudged Sam today', '... with that reason');
SELECT pg_temp.backdate('20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b1', 23);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-0000000000b1', '300')), 'HS409', '... still refused 23 hours later');
SELECT pg_temp.backdate('20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b1', 2);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-0000000000b1', '300')), 'applied', '... and allowed again 25 hours later');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.nudge('60000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-0000000000d1', '200')), 'HS409', 'Sam''s own nudge to Gus earlier today still counts');

-- Paid back in full (confirmed), Sam owes nothing: no nudge, even after a day.
SELECT pg_temp.backdate('20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b1', 48);
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "payment.record", "groupId": "10000000-0000-0000-0000-000000000001", "entryId": "30000000-0000-0000-0000-000000000004", "fromMemberId": "20000000-0000-0000-0000-0000000000b1", "toMemberId": "20000000-0000-0000-0000-0000000000a1", "amountCents": 300, "entryDate": "2026-11-03", "notes": null}'), 'applied', 'Sam pays Alex back 300');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-0000000000b1', '300')), 'applied', 'while the payment waits for Alex, Sam still owes and can be nudged');
SELECT pg_temp.backdate('20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b1', 48);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "payment.confirm", "groupId": "10000000-0000-0000-0000-000000000001", "entryId": "30000000-0000-0000-0000-000000000004"}'), 'applied', 'Alex confirms');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.nudge('60000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-0000000000b1', '300')), 'HS422', 'once paid back, Sam can''t be nudged');

-- ---------------------------------------------------------------------------
-- Pull and visibility
-- ---------------------------------------------------------------------------
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.pull('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')#>'{changes,0}') k),
    ARRAY['conflicts', 'entries', 'group_id', 'groups', 'guest_codes', 'invites', 'members', 'nudges', 'version'],
    'a pulled group change has exactly these keys'
);
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.pull('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')#>'{changes,0,nudges,0}') k),
    ARRAY['amount_cents', 'created_at', 'from_member_id', 'group_id', 'id', 'row_version', 'to_member_id'],
    'a pulled nudge has exactly these keys'
);
SELECT is(
    jsonb_array_length(pg_temp.pull('dddddddd-dddd-dddd-dddd-dddddddddddd')#>'{changes,0,nudges}'),
    5,
    'every member pulls all of the group''s nudges (screens show each to its two people)'
);
SELECT is(
    jsonb_array_length(pg_temp.pull('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', jsonb_build_object('10000000-0000-0000-0000-000000000001', (SELECT row_version FROM public.nudges WHERE id = '60000000-0000-0000-0000-000000000004')))#>'{changes,0,nudges}'),
    1,
    'a pull past a cursor sends only the newer nudges'
);
SELECT is(pg_temp.visible_nudges('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 5::BIGINT, 'a member can select the group''s nudges');
SELECT is(pg_temp.visible_nudges('cccccccc-cccc-cccc-cccc-cccccccccccc'), 0::BIGINT, 'someone outside the group sees none');
SELECT pg_temp.sign_in('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
SELECT throws_ok('SELECT pg_temp.insert_nudge_signed_in()', '42501', NULL, 'a device can''t insert nudges directly');

-- ---------------------------------------------------------------------------
-- A completed group refuses nudges
-- ---------------------------------------------------------------------------
SELECT pg_temp.backdate('20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000d1', 48);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.complete", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'Alex completes group 1');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.nudge('60000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-0000000000d1', '200')), 'HS403', 'no nudges in a completed group');

SELECT * FROM finish();
ROLLBACK;
