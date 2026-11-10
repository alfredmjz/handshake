-- ============================================================================
-- pgTAP tests for completing a group (migration 008). group.complete (owner only) makes the group
-- read-only and, in the same change, takes away the access of every guest who never added an email:
-- their row becomes a name-only non-member (history kept), and their login is deleted unless they are
-- still in another group. group.reopen makes it editable again. Through push_changes(); rolled back.
-- ============================================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

-- ---------------------------------------------------------------------------
-- Helpers: act as a signed-in user (a guest when their auth user is anonymous), or signed out
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
CREATE FUNCTION pg_temp.upgrade_signed_in() RETURNS VOID LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.upgrade_guest();
$$;
CREATE FUNCTION pg_temp.preview_signed_out(p_token TEXT) RETURNS JSONB LANGUAGE plpgsql SET role = 'anon' AS $$
BEGIN
    PERFORM set_config('request.jwt.claims', '{"role": "anon"}', true);
    RETURN public.preview_invite(p_token);
END $$;
CREATE FUNCTION pg_temp.push(p_user UUID, p_mutation JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.push_signed_in(jsonb_build_array(jsonb_build_object('id', gen_random_uuid()) || p_mutation));
END $$;
-- 'applied', or the rejection's code.
CREATE FUNCTION pg_temp.try(p_user UUID, p_mutation JSONB) RETURNS TEXT LANGUAGE sql AS $$
    SELECT COALESCE(r#>>'{rejected,0,code}', 'applied') FROM pg_temp.push(p_user, p_mutation) r;
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
CREATE FUNCTION pg_temp.upgrade(p_user UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    PERFORM pg_temp.upgrade_signed_in();
END $$;
CREATE FUNCTION pg_temp.head(p_group UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT head_version FROM public.groups WHERE id = p_group;
$$;
CREATE FUNCTION pg_temp.version_of(p_entry UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT row_version FROM public.ledger_entries WHERE id = p_entry;
$$;
-- p_payer paid 900 for something Alex, Sam and p_other split: 300 each.
CREATE FUNCTION pg_temp.expense(p_entry UUID, p_payer UUID, p_other UUID) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'type', 'entry.create',
        'groupId', '10000000-0000-0000-0000-000000000001',
        'entryId', p_entry,
        'kind', 'expense',
        'description', 'Groceries',
        'amountCents', 900,
        'entryDate', '2026-11-02',
        'notes', NULL,
        'items', jsonb_build_array(jsonb_build_object('amountCents', 900, 'paidBy', p_payer,
            'splitAmong', jsonb_build_array('20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b1', p_other))),
        'shares', (
            SELECT jsonb_agg(jsonb_build_object('memberId', m, 'paidCents', CASE WHEN m = p_payer THEN 900 ELSE 0 END, 'owedCents', 300, 'owedTo', jsonb_build_object(p_payer, 300)))
            FROM unnest(ARRAY['20000000-0000-0000-0000-0000000000a1'::UUID, '20000000-0000-0000-0000-0000000000b1'::UUID, p_other]) AS m
        )
    );
$$;

-- ---------------------------------------------------------------------------
-- Group 1 is Alex's. Sam is a member. Kim, Lee and Max are guests; Lee is also a guest in Sam's group 2;
-- Max left group 1 before it was completed. Jo joined as a guest but added an email, so is a member now.
-- Users: aaaa… Alex, bbbb… Sam, cccc… Jo, dddd… Kim, eeee… Lee, 9999… Max (all but Alex and Sam start
-- anonymous). Members 2000…<person><group>, Max is 2000…91.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@complete.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@complete.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('99999999-9999-9999-9999-999999999999', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Banff", "displayName": "Alex"}'), 'applied', 'Alex creates group 1');
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('type', 'member.add', 'groupId', '10000000-0000-0000-0000-000000000001', 'memberId', p.id, 'displayName', p.name)),
    'applied',
    'Alex adds ' || p.name
)
FROM (VALUES ('20000000-0000-0000-0000-0000000000b1', 'Sam'), ('20000000-0000-0000-0000-0000000000c1', 'Jo'), ('20000000-0000-0000-0000-0000000000d1', 'Kim'),
             ('20000000-0000-0000-0000-0000000000e1', 'Lee'), ('20000000-0000-0000-0000-000000000091', 'Max')) AS p(id, name);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000001", "token": "completetestinvitetoken00000000000000000001"}'), 'applied', 'Alex makes a link');
SELECT is(pg_temp.join(j.who, 'completetestinvitetoken00000000000000000001', j.claim), '10000000-0000-0000-0000-000000000001'::UUID, j.name || ' joins')
FROM (VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::UUID, '20000000-0000-0000-0000-0000000000b1'::UUID, 'Sam'),
             ('cccccccc-cccc-cccc-cccc-cccccccccccc', '20000000-0000-0000-0000-0000000000c1', 'Jo'),
             ('dddddddd-dddd-dddd-dddd-dddddddddddd', '20000000-0000-0000-0000-0000000000d1', 'Kim'),
             ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '20000000-0000-0000-0000-0000000000e1', 'Lee'),
             ('99999999-9999-9999-9999-999999999999', '20000000-0000-0000-0000-000000000091', 'Max')) AS j(who, claim, name);

SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000b2", "name": "Sam''s", "displayName": "Sam"}'), 'applied', 'Sam creates group 2');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000002", "inviteId": "50000000-0000-0000-0000-000000000002", "token": "completetestinvitetoken00000000000000000002"}'), 'applied', 'Sam makes a link');
SELECT is(pg_temp.join('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'completetestinvitetoken00000000000000000002', NULL, 'Lee'), '10000000-0000-0000-0000-000000000002'::UUID, 'Lee joins group 2 as a guest too');

SELECT is(pg_temp.try('99999999-9999-9999-9999-999999999999', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-000000000091"}'), 'applied', 'Max leaves group 1');

UPDATE auth.users SET email = 'jo@complete.test', is_anonymous = FALSE WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
SELECT lives_ok($$ SELECT pg_temp.upgrade('cccccccc-cccc-cccc-cccc-cccccccccccc') $$, 'Jo adds an email and keeps their data');

SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.expense('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-0000000000d1')), 'applied', 'Kim adds groceries Kim paid for');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.expense('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000e1')), 'applied', 'Sam adds groceries Lee shares');

SELECT results_eq(
    $$ SELECT id::TEXT, role, user_id IS NOT NULL, deleted_at IS NOT NULL FROM public.group_members WHERE group_id = '10000000-0000-0000-0000-000000000001' ORDER BY id $$,
    $$ VALUES ('20000000-0000-0000-0000-000000000091', 'guest', TRUE, TRUE), ('20000000-0000-0000-0000-0000000000a1', 'owner', TRUE, FALSE),
              ('20000000-0000-0000-0000-0000000000b1', 'member', TRUE, FALSE), ('20000000-0000-0000-0000-0000000000c1', 'member', TRUE, FALSE),
              ('20000000-0000-0000-0000-0000000000d1', 'guest', TRUE, FALSE), ('20000000-0000-0000-0000-0000000000e1', 'guest', TRUE, FALSE) $$,
    'before completing: Max a guest who left, Alex owner, Sam and Jo members, Kim and Lee guests'
);

-- ---------------------------------------------------------------------------
-- Only the owner completes
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "group.complete", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'HS403', 'a member can''t complete the group');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.complete", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'the owner completes it, though Sam and Lee still owe');

SELECT results_eq(
    $$ SELECT completed_at = NOW(), completed_by_member_id::TEXT, row_version = head_version FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001' $$,
    $$ VALUES (TRUE, '20000000-0000-0000-0000-0000000000a1', TRUE) $$,
    'it is completed now, by Alex''s member row, at the next version'
);

-- ---------------------------------------------------------------------------
-- Guests without an email lose access; their names and history stay
-- ---------------------------------------------------------------------------
SELECT results_eq(
    $$ SELECT id::TEXT, display_name, user_id, role, joined_at, deleted_at IS NOT NULL, row_version = (SELECT head_version FROM public.groups WHERE id = group_id)
       FROM public.group_members WHERE id IN ('20000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-0000000000e1', '20000000-0000-0000-0000-000000000091') ORDER BY id $$,
    $$ VALUES ('20000000-0000-0000-0000-000000000091', 'Max', NULL::UUID, 'member', NULL::TIMESTAMPTZ, TRUE, TRUE),
              ('20000000-0000-0000-0000-0000000000d1', 'Kim', NULL::UUID, 'member', NULL::TIMESTAMPTZ, FALSE, TRUE),
              ('20000000-0000-0000-0000-0000000000e1', 'Lee', NULL::UUID, 'member', NULL::TIMESTAMPTZ, FALSE, TRUE) $$,
    'every guest row (Max''s, who left, too) becomes a name-only non-member: same id and name, no user, not joined, stamped'
);
SELECT results_eq(
    $$ SELECT created_by_member_id::TEXT, (SELECT sum(paid_cents) FROM public.ledger_shares WHERE entry_id = e.id), (SELECT sum(owed_cents) FROM public.ledger_shares WHERE entry_id = e.id),
              (SELECT owed_cents FROM public.ledger_shares WHERE entry_id = e.id AND member_id = '20000000-0000-0000-0000-0000000000d1')
       FROM public.ledger_entries e WHERE id = '30000000-0000-0000-0000-000000000001' $$,
    $$ VALUES ('20000000-0000-0000-0000-0000000000d1', 900::NUMERIC, 900::NUMERIC, 300::BIGINT) $$,
    'Kim''s entry still says Kim added it, and Kim''s shares still add up'
);
SELECT results_eq(
    $$ SELECT u.id::TEXT, (SELECT count(*)::INT FROM public.profiles p WHERE p.id = u.id) FROM auth.users u
       WHERE u.id IN ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '99999999-9999-9999-9999-999999999999')
       ORDER BY u.id $$,
    $$ VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', 1), ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 1) $$,
    'the logins of Kim and Max (in no other group) are deleted with their profiles; Lee''s (still in group 2) and Jo''s (has an email) stay'
);
SELECT is((SELECT count(*)::INT FROM public.sync_mutations WHERE user_id IN ('dddddddd-dddd-dddd-dddd-dddddddddddd', '99999999-9999-9999-9999-999999999999')), 0, 'their sync_mutations rows went with them');
SELECT results_eq(
    $$ SELECT user_id::TEXT, role FROM public.group_members WHERE id IN ('20000000-0000-0000-0000-0000000000c1') $$,
    $$ VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'member') $$,
    'Jo, who added an email before, is untouched'
);
SELECT is(
    (SELECT role FROM public.group_members WHERE group_id = '10000000-0000-0000-0000-000000000002' AND user_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
    'guest',
    'Lee is still a guest in group 2'
);
SELECT is(pg_temp.pull('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')->'group_ids', '["10000000-0000-0000-0000-000000000002"]'::JSONB, 'Lee''s next pull drops group 1 and keeps group 2');
SELECT is(pg_temp.pull('dddddddd-dddd-dddd-dddd-dddddddddddd')->'group_ids', '[]'::JSONB, 'Kim can no longer pull the group');

SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')#>'{changes,0,groups,0}') k),
    ARRAY['base_currency', 'completed_at', 'completed_by_member_id', 'created_at', 'created_by', 'deleted_at', 'id', 'name', 'note', 'row_version'],
    'a pulled group has exactly these keys'
);
SELECT is(
    pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')#>>'{changes,0,groups,0,completed_by_member_id}',
    '20000000-0000-0000-0000-0000000000a1',
    '... and other devices learn who completed it'
);

-- ---------------------------------------------------------------------------
-- A completed group is read-only
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try(t.who, t.mutation), 'HS403', 'in a completed group, ' || t.what || ' is refused')
FROM (VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::UUID, pg_temp.expense('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000c1'), 'adding an entry'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.expense('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000e1')
        || jsonb_build_object('type', 'entry.update', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000002'), 'description', 'Food'), 'editing an entry'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', jsonb_build_object('type', 'entry.delete', 'groupId', '10000000-0000-0000-0000-000000000001', 'entryId', '30000000-0000-0000-0000-000000000002', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000002')), 'deleting an entry'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000003", "token": "completetestinvitetoken00000000000000000003"}', 'making an invite'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-000000000092", "displayName": "Ren"}', 'adding someone'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.rename", "groupId": "10000000-0000-0000-0000-000000000001", "name": "Banff (done)"}', 'renaming the group'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1"}', 'removing someone else'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.complete", "groupId": "10000000-0000-0000-0000-000000000001"}', 'completing it again')
) AS t(who, mutation, what);
SELECT throws_ok($$ SELECT pg_temp.preview_signed_out('completetestinvitetoken00000000000000000001') $$, 'HS404', NULL, 'its links stop working');
SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000c1"}'), 'applied', 'leaving still works (member.remove.self is allowed when completed)');
SELECT is((SELECT deleted_at IS NOT NULL FROM public.group_members WHERE id = '20000000-0000-0000-0000-0000000000c1'), TRUE, 'Jo has left');

-- ---------------------------------------------------------------------------
-- Reopening (owner only) makes it editable again
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "group.reopen", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'HS403', 'a member can''t reopen it');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.reopen", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'the owner reopens it');
SELECT results_eq(
    $$ SELECT completed_at, completed_by_member_id, row_version = head_version FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001' $$,
    $$ VALUES (NULL::TIMESTAMPTZ, NULL::UUID, TRUE) $$,
    'it is open again, at the next version'
);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.reopen", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'reopening an open group is accepted and does nothing');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.expense('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000c1')), 'applied', 'entries work again');
SELECT is(
    pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.expense('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000e1')
        || jsonb_build_object('type', 'entry.update', 'baseVersion', pg_temp.version_of('30000000-0000-0000-0000-000000000002'), 'description', 'Food')),
    'applied',
    '... edits too'
);
SELECT is(pg_temp.preview_signed_out('completetestinvitetoken00000000000000000001')->'unclaimed' @> '[{"displayName": "Kim"}]'::JSONB, TRUE, 'the old link works again, offering Kim''s name to claim');

-- Kim's deleted login doesn't come back, but whoever joins as Kim takes over Kim's history.
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES ('dddddddd-0000-0000-0000-00000000000d', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}');
SELECT is(pg_temp.join('dddddddd-0000-0000-0000-00000000000d', 'completetestinvitetoken00000000000000000001', '20000000-0000-0000-0000-0000000000d1'), '10000000-0000-0000-0000-000000000001'::UUID, 'a new guest login joins as Kim');
SELECT ok(
    (SELECT e->>'created_by_member_id' = '20000000-0000-0000-0000-0000000000d1'
     FROM jsonb_array_elements(pg_temp.pull('dddddddd-0000-0000-0000-00000000000d')#>'{changes,0,entries}') e
     WHERE e->>'id' = '30000000-0000-0000-0000-000000000001'),
    '... and sees the groceries Kim added as their own'
);

-- ---------------------------------------------------------------------------
-- A completed group can still be deleted
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.complete", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'the owner completes it again');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.delete", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', '... and then deletes it');
SELECT is((SELECT deleted_at IS NOT NULL FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001'), TRUE, 'it is deleted');

SELECT * FROM finish();
ROLLBACK;
