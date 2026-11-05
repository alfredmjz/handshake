-- ============================================================================
-- pgTAP tests for deleting an account (migration 008, spec decision 19): delete_account(), called as the
-- signed-in person. Their rows become name-only people with the same name, groups they own pass on (or go
-- when no full member is left), pending payments are undone, and their login and API tokens go. Everything
-- is rolled back.
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


CREATE FUNCTION pg_temp.delete_signed_in() RETURNS VOID LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.delete_account();
$$;
CREATE FUNCTION pg_temp.delete_account(p_user UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    PERFORM pg_temp.delete_signed_in();
END $$;
CREATE FUNCTION pg_temp.create_token_signed_in(p_name TEXT) RETURNS JSONB LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.create_api_token(p_name);
$$;
CREATE FUNCTION pg_temp.sqlstate_signed_out(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql SET role = 'anon' AS $$
BEGIN
    PERFORM set_config('request.jwt.claims', '{"role": "anon"}', true);
    EXECUTE p_sql;
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
END $$;
CREATE FUNCTION pg_temp.pay(p_group UUID, p_entry UUID, p_from UUID, p_to UUID, p_amount INT) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('type', 'payment.record', 'groupId', p_group, 'entryId', p_entry,
        'fromMemberId', p_from, 'toMemberId', p_to, 'amountCents', p_amount, 'entryDate', '2026-11-04', 'notes', NULL);
$$;

-- ---------------------------------------------------------------------------
-- Alex owns Banff (group 1, with Jo and Sam) and Solo (group 3, where Kim is a guest), and is a member of
-- Sam's Jasper (group 2). Users: aaaa… Alex, bbbb… Sam, cccc… Jo, dddd… Kim (anonymous).
-- Members 2000…<person><group>; entries 3000…N.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@delete.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@delete.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'jo@delete.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Jo"}'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Banff", "displayName": "Alex"}'), 'applied', 'Alex creates Banff');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000001", "token": "deletetestinvitetoken0000000000000000000001"}'), 'applied', 'Alex makes a link to Banff');
SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'deletetestinvitetoken0000000000000000000001', NULL, 'Sam'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam joins Banff');
SELECT is(pg_temp.join('cccccccc-cccc-cccc-cccc-cccccccccccc', 'deletetestinvitetoken0000000000000000000001', NULL, 'Jo'), '10000000-0000-0000-0000-000000000001'::UUID, 'Jo joins Banff');
-- Joined in the same transaction, so NOW() is the same: move Jo to two days ago, so Jo joined first.
UPDATE public.group_members SET joined_at = joined_at - INTERVAL '2 days' WHERE user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000b2", "name": "Jasper", "displayName": "Sam"}'), 'applied', 'Sam creates Jasper');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000002", "inviteId": "50000000-0000-0000-0000-000000000002", "token": "deletetestinvitetoken0000000000000000000002"}'), 'applied', 'Sam makes a link to Jasper');
SELECT is(pg_temp.join('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'deletetestinvitetoken0000000000000000000002', NULL, 'Alex'), '10000000-0000-0000-0000-000000000002'::UUID, 'Alex joins Jasper');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000003", "memberId": "20000000-0000-0000-0000-0000000000a3", "name": "Solo", "displayName": "Alex"}'), 'applied', 'Alex creates Solo');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000003", "inviteId": "50000000-0000-0000-0000-000000000003", "token": "deletetestinvitetoken0000000000000000000003"}'), 'applied', 'Alex makes a link to Solo');
SELECT is(pg_temp.join('dddddddd-dddd-dddd-dddd-dddddddddddd', 'deletetestinvitetoken0000000000000000000003', NULL, 'Kim'), '10000000-0000-0000-0000-000000000003'::UUID, 'Kim joins Solo as a guest');

-- Sam paid 1000 for dinner in Banff, split by Alex and Sam: 500 each, so Alex owes Sam 500.
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', jsonb_build_object(
        'type', 'entry.create', 'groupId', '10000000-0000-0000-0000-000000000001', 'entryId', '30000000-0000-0000-0000-000000000001',
        'description', 'Dinner', 'amountCents', 1000, 'entryDate', '2026-11-04', 'notes', NULL,
        'items', jsonb_build_array(jsonb_build_object('amountCents', 1000, 'paidBy', (SELECT id FROM public.group_members WHERE user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND group_id = '10000000-0000-0000-0000-000000000001'),
            'splitAmong', jsonb_build_array('20000000-0000-0000-0000-0000000000a1', (SELECT id FROM public.group_members WHERE user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND group_id = '10000000-0000-0000-0000-000000000001')))),
        'shares', jsonb_build_array(
            jsonb_build_object('memberId', '20000000-0000-0000-0000-0000000000a1', 'paidCents', 0, 'owedCents', 500,
                'owedTo', jsonb_build_object((SELECT id FROM public.group_members WHERE user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND group_id = '10000000-0000-0000-0000-000000000001'), 500)),
            jsonb_build_object('memberId', (SELECT id FROM public.group_members WHERE user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND group_id = '10000000-0000-0000-0000-000000000001'), 'paidCents', 1000, 'owedCents', 500,
                'owedTo', jsonb_build_object((SELECT id FROM public.group_members WHERE user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND group_id = '10000000-0000-0000-0000-000000000001'), 500))
        )
    )),
    'applied',
    'Sam adds a dinner Alex owes Sam 500 for'
);
CREATE TEMP TABLE sam AS SELECT id FROM public.group_members WHERE user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND group_id = '10000000-0000-0000-0000-000000000001';
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.pay('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000a1', (SELECT id FROM sam), 200)),
    'applied',
    'Alex records paying Sam 200, which waits for Sam'
);

CREATE FUNCTION pg_temp.create_token(p_user UUID, p_name TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.create_token_signed_in(p_name);
END $$;
SELECT ok(pg_temp.create_token('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Pholio') ? 'token', 'Alex connects Pholio');

CREATE TEMP TABLE before AS SELECT id, head_version FROM public.groups;

-- ---------------------------------------------------------------------------
-- Alex deletes their account
-- ---------------------------------------------------------------------------
SELECT lives_ok($$ SELECT pg_temp.delete_account('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$, 'Alex deletes their account, though Alex still owes Sam');

SELECT results_eq(
    $$ SELECT group_id::TEXT, display_name, user_id, role, joined_at, deleted_at,
              row_version = (SELECT head_version FROM public.groups g WHERE g.id = gm.group_id)
       FROM public.group_members gm WHERE id IN ('20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a3')
           OR (group_id = '10000000-0000-0000-0000-000000000002' AND display_name = 'Alex') ORDER BY group_id $$,
    $$ VALUES ('10000000-0000-0000-0000-000000000001', 'Alex', NULL::UUID, 'member', NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, TRUE),
              ('10000000-0000-0000-0000-000000000002', 'Alex', NULL::UUID, 'member', NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, TRUE),
              ('10000000-0000-0000-0000-000000000003', 'Alex', NULL::UUID, 'member', NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, TRUE) $$,
    'every row of Alex''s becomes a name-only person with the same name, at its group''s next version'
);
SELECT results_eq(
    $$ SELECT id::TEXT, head_version - (SELECT head_version FROM before b WHERE b.id = g.id) FROM public.groups g ORDER BY id $$,
    $$ VALUES ('10000000-0000-0000-0000-000000000001', 1::BIGINT), ('10000000-0000-0000-0000-000000000002', 1::BIGINT), ('10000000-0000-0000-0000-000000000003', 1::BIGINT) $$,
    'each of Alex''s groups took exactly one version, so the others pull the change'
);
SELECT is(
    (SELECT display_name FROM public.group_members WHERE group_id = '10000000-0000-0000-0000-000000000001' AND role = 'owner'),
    'Jo',
    'Banff passes to Jo, the full member who joined first'
);
SELECT results_eq(
    $$ SELECT deleted_at IS NOT NULL FROM public.groups WHERE id IN ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003') ORDER BY id $$,
    $$ VALUES (FALSE), (TRUE) $$,
    'Jasper (Sam''s) stays; Solo, with only a guest left, is deleted'
);
SELECT results_eq(
    $$ SELECT payment_status, closed_at IS NOT NULL FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000002' $$,
    $$ VALUES ('undone', TRUE) $$,
    'Alex''s pending payment is undone'
);
SELECT is((SELECT owed_cents FROM public.ledger_shares WHERE entry_id = '30000000-0000-0000-0000-000000000001' AND member_id = '20000000-0000-0000-0000-0000000000a1'), 500::BIGINT, 'Alex''s debt stays, under Alex''s name');
SELECT results_eq(
    $$ SELECT (SELECT count(*)::INT FROM auth.users WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
              (SELECT count(*)::INT FROM public.profiles WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
              (SELECT count(*)::INT FROM public.api_tokens WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
              (SELECT count(*)::INT FROM public.sync_mutations WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $$,
    $$ VALUES (0, 0, 0, 0) $$,
    'Alex''s login, profile, API tokens and sync_mutations are gone'
);
SELECT results_eq(
    $$ SELECT (SELECT count(*)::INT FROM public.groups WHERE created_by IS NULL), (SELECT count(*)::INT FROM public.group_invites WHERE created_by IS NULL) $$,
    $$ VALUES (2, 2) $$,
    'the groups and links Alex made stay, with no creator'
);
SELECT is(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->'group_ids', '[]'::JSONB, 'Alex''s old login pulls nothing');

SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.pay('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000a1', (SELECT id FROM sam), 500)),
    'applied',
    'Sam records "Alex paid me $5.00", now that Alex has no login'
);
SELECT is((SELECT payment_status FROM public.ledger_entries WHERE id = '30000000-0000-0000-0000-000000000003'), 'confirmed', '... and it counts at once');

-- ---------------------------------------------------------------------------
-- Guests can delete their account too; signed out, nobody can
-- ---------------------------------------------------------------------------
SELECT lives_ok($$ SELECT pg_temp.delete_account('dddddddd-dddd-dddd-dddd-dddddddddddd') $$, 'Kim, a guest, deletes their account');
SELECT results_eq(
    $$ SELECT (SELECT count(*)::INT FROM auth.users WHERE id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
              (SELECT count(*)::INT FROM public.group_members WHERE display_name = 'Kim' AND user_id IS NULL) $$,
    $$ VALUES (0, 1) $$,
    'Kim''s login is gone and Kim stays as a name-only person'
);
SELECT is(pg_temp.sqlstate_signed_out('SELECT public.delete_account()'), '42501', 'signed out, delete_account can''t be called');

SELECT * FROM finish();
ROLLBACK;
