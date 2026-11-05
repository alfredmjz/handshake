-- ============================================================================
-- pgTAP tests for people (migration 004): roles, member.add, member.rename, member.remove (and leaving),
-- group.rename and group.delete. There is no admin role: the owner alone manages people and the group.
-- Every change goes through push_changes() as a signed-in test user; results are read back through
-- pull_changes() and the tables. Everything is rolled back.
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

-- ---------------------------------------------------------------------------
-- People: Alex owns group 1; Sam, Jo and Lee join as members; Kim is a guest; Pat never joins.
-- Ids: users aaaa… Alex, bbbb… Sam, cccc… Jo, dddd… Kim (anonymous), eeee… Lee; groups 1000…0N;
-- members 2000…<person><group>, e.g. 2000…a1 is Alex in group 1.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@people.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@people.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'jo@people.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Jo"}'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'lee@people.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Lee"}');

SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Banff", "displayName": "Alex"}'),
    'applied',
    'Alex creates group 1'
);

SELECT results_eq(
    $$ SELECT base_currency::TEXT, (SELECT joined_at IS NOT NULL FROM public.group_members WHERE id = '20000000-0000-0000-0000-0000000000a1')
       FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001' $$,
    $$ VALUES ('CAD', TRUE) $$,
    'without baseCurrency the group keeps the column default, and the owner has joined'
);

SELECT is(
    pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000009", "memberId": "20000000-0000-0000-0000-0000000000d9", "name": "Kim''s trip", "displayName": "Kim"}'),
    'HS403',
    'a guest (anonymous user) cannot create a group'
);

-- ---------------------------------------------------------------------------
-- The owner adds people by name; they can be in bills before they join
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('type', 'member.add', 'groupId', '10000000-0000-0000-0000-000000000001', 'memberId', p.id, 'displayName', p.name)),
    'applied',
    'the owner adds ' || p.name || ' by name'
)
FROM (VALUES
    ('20000000-0000-0000-0000-0000000000b1', 'Sam'),
    ('20000000-0000-0000-0000-0000000000c1', 'Jo'),
    ('20000000-0000-0000-0000-0000000000d1', 'Kim'),
    ('20000000-0000-0000-0000-0000000000e1', 'Lee'),
    ('20000000-0000-0000-0000-0000000000f1', ' Pat ')
) AS p(id, name);

SELECT results_eq(
    $$ SELECT user_id, display_name, role, joined_at, deleted_at, row_version FROM public.group_members WHERE id = '20000000-0000-0000-0000-0000000000f1' $$,
    $$ VALUES (NULL::UUID, 'Pat', 'member', NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, 6::BIGINT) $$,
    'a non-member has no user and no joined_at, is stored trimmed, and has the fifth add''s version (6)'
);

SELECT is(pg_temp.head('10000000-0000-0000-0000-000000000001'), 6::BIGINT, 'create (1) and five adds (2–6) took one version each');

SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000001", "token": "peopletestinvitetoken0000000000000000000001", "claimMemberId": null}'),
    'applied',
    'Alex makes an invite link'
);

SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'peopletestinvitetoken0000000000000000000001', '20000000-0000-0000-0000-0000000000b1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam joins as Sam');
SELECT is(pg_temp.join('cccccccc-cccc-cccc-cccc-cccccccccccc', 'peopletestinvitetoken0000000000000000000001', '20000000-0000-0000-0000-0000000000c1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Jo joins as Jo');
SELECT is(pg_temp.join('dddddddd-dddd-dddd-dddd-dddddddddddd', 'peopletestinvitetoken0000000000000000000001', '20000000-0000-0000-0000-0000000000d1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Kim joins as Kim');
SELECT is(pg_temp.join('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'peopletestinvitetoken0000000000000000000001', '20000000-0000-0000-0000-0000000000e1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Lee joins as Lee');

-- Everyone joined within this one transaction, so NOW() is the same for all of them. Jo is moved to
-- two days ago, so "joined first" is decided by joined_at and not by member id (Sam's sorts first).
UPDATE public.group_members SET joined_at = joined_at - INTERVAL '2 days' WHERE id = '20000000-0000-0000-0000-0000000000c1';

SELECT results_eq(
    $$ SELECT id::TEXT, role FROM public.group_members WHERE group_id = '10000000-0000-0000-0000-000000000001' ORDER BY id $$,
    $$ VALUES ('20000000-0000-0000-0000-0000000000a1', 'owner'), ('20000000-0000-0000-0000-0000000000b1', 'member'),
              ('20000000-0000-0000-0000-0000000000c1', 'member'), ('20000000-0000-0000-0000-0000000000d1', 'guest'),
              ('20000000-0000-0000-0000-0000000000e1', 'member'), ('20000000-0000-0000-0000-0000000000f1', 'member') $$,
    'roles: Alex owner, Sam, Jo and Lee members, Kim a guest (anonymous), Pat a non-member'
);

SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.pull('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')#>'{changes,0,members,0}') k),
    ARRAY['deleted_at', 'display_name', 'group_id', 'id', 'joined_at', 'role', 'row_version', 'user_id'],
    'a pulled member has exactly the keys wire.ts reads'
);

-- ---------------------------------------------------------------------------
-- A member adds people and makes invites, but can't manage others or the group. One call per action
-- here proves each apply_* asks for the right one; the matrix is pinned in permission_cases.test.sql.
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-000000000091", "displayName": "Max"}'), 'applied', 'a member adds someone by name (member.add)');
SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-000000000092", "displayName": "Ned"}'), 'HS403', 'a guest can''t (member.add)');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "Patricia"}'), 'HS403', 'a member cannot rename someone else');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "group.rename", "groupId": "10000000-0000-0000-0000-000000000001", "name": "Sam''s Banff"}'), 'HS403', 'a member cannot rename the group');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1"}'), 'HS403', 'a member cannot remove a non-member');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000c1"}'), 'HS403', 'a member cannot remove another member');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000d1"}'), 'HS403', 'a member cannot remove a guest');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000002", "token": "peopletestinvitetoken0000000000000000000002"}'), 'applied', 'a member makes an invite (invite.create)');
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "group.delete", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'HS403', 'a member cannot delete the group');

SELECT is(
    pg_temp.push('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "Patricia"}')#>>'{rejected,0,reason}',
    'Only the group''s owner can do this',
    '... and is told why'
);

-- ---------------------------------------------------------------------------
-- Renaming: yourself, or the owner for anyone
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1", "displayName": "Samantha"}'), 'applied', 'a member renames themselves');
SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000d1", "displayName": "Kimberly"}'), 'applied', 'a guest renames themselves');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "Patricia"}'), 'applied', 'the owner renames a non-member');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1", "displayName": "Sam"}'), 'applied', 'the owner renames a member');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-000000000099", "displayName": "Nobody"}'), 'HS422', 'renaming someone who is not in the group is invalid');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1", "displayName": "  "}'), '23514', 'a blank name is refused by the table''s check');

SELECT results_eq(
    $$ SELECT display_name FROM public.group_members WHERE id IN ('20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000d1', '20000000-0000-0000-0000-0000000000f1') ORDER BY id $$,
    $$ VALUES ('Sam'), ('Kimberly'), ('Patricia') $$,
    'the renames were stored'
);

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.rename", "groupId": "10000000-0000-0000-0000-000000000001", "name": "Banff 2027"}'), 'applied', 'the owner renames the group');

-- ---------------------------------------------------------------------------
-- The owner removes people; anyone can leave
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1"}'), 'applied', 'the owner removes a non-member');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000d1"}'), 'applied', 'the owner removes a guest');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e1"}'), 'applied', 'the owner removes a member');

SELECT results_eq(
    $$ SELECT id::TEXT, user_id IS NOT NULL, deleted_at IS NOT NULL, row_version = (SELECT head_version FROM public.groups WHERE id = group_id)
       FROM public.group_members WHERE id IN ('20000000-0000-0000-0000-0000000000e1') $$,
    $$ VALUES ('20000000-0000-0000-0000-0000000000e1', TRUE, TRUE, TRUE) $$,
    'a removed member keeps their row and user (soft delete), stamped with the latest version'
);

SELECT is(
    (SELECT count(*)::INT FROM public.group_members WHERE group_id = '10000000-0000-0000-0000-000000000001' AND deleted_at IS NOT NULL),
    3,
    'Pat, Kim and Lee are removed'
);

SELECT is(
    pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.head('10000000-0000-0000-0000-000000000001') - 3))#>'{changes,0,members}' @> '[{"display_name": "Lee"}, {"display_name": "Kimberly"}, {"display_name": "Patricia"}]'::JSONB,
    TRUE,
    'the removals reach other devices as member rows with deleted_at'
);

SELECT is(
    pg_temp.head('10000000-0000-0000-0000-000000000001'),
    21::BIGINT,
    'one version per applied change: create 1, adds 2–6, invite 7, joins 8–11, Sam''s add 12 and invite 13, renames 14–17, group rename 18, removals 19–21; rejected changes take none'
);

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e1"}'), 'applied', 'removing someone already removed (another device did it) is accepted');
SELECT is(pg_temp.head('10000000-0000-0000-0000-000000000001'), 21::BIGINT, '... and changes nothing');

SELECT is(pg_temp.try('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e1", "displayName": "Lee again"}'), 'HS403', 'someone removed can no longer change the group');
SELECT is(pg_temp.pull('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')->'group_ids', '[]'::JSONB, '... and their next pull drops it');

-- ---------------------------------------------------------------------------
-- The owner leaving hands over to the full member who joined first
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1"}'), 'applied', 'the owner leaves');

SELECT results_eq(
    $$ SELECT display_name, role, deleted_at IS NOT NULL, row_version FROM public.group_members
       WHERE group_id = '10000000-0000-0000-0000-000000000001' AND role <> 'guest' AND user_id IS NOT NULL ORDER BY display_name $$,
    $$ VALUES ('Alex', 'member', TRUE, 22::BIGINT), ('Jo', 'owner', FALSE, 22::BIGINT), ('Lee', 'member', TRUE, 21::BIGINT), ('Sam', 'member', FALSE, 17::BIGINT) $$,
    'Jo, who joined first, is the new owner (not Sam, whose id sorts first) and Alex''s removed row is no longer the owner, both in one version'
);

SELECT is(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->'group_ids', '[]'::JSONB, 'the group drops from the old owner''s device');
SELECT is(
    pg_temp.pull('cccccccc-cccc-cccc-cccc-cccccccccccc', '{"10000000-0000-0000-0000-000000000001": 21}')#>'{changes,0,members}' @> '[{"display_name": "Jo", "role": "owner"}]'::JSONB,
    TRUE,
    'the new role reaches the other devices'
);
SELECT is(pg_temp.try('cccccccc-cccc-cccc-cccc-cccccccccccc', '{"type": "group.rename", "groupId": "10000000-0000-0000-0000-000000000001", "name": "Jo''s Banff"}'), 'applied', 'the new owner can do the owner''s jobs');

SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000b1"}'), 'applied', 'a member leaves');
SELECT is(
    (SELECT deleted_at IS NULL FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001'),
    TRUE,
    '... and the group stays: its owner is still in it'
);

-- ---------------------------------------------------------------------------
-- The last full member leaving deletes the group, even with a guest left
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000a2", "name": "Jasper", "displayName": "Alex"}'), 'applied', 'Alex creates group 2');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.create", "groupId": "10000000-0000-0000-0000-000000000002", "inviteId": "50000000-0000-0000-0000-000000000003", "token": "peopletestinvitetoken0000000000000000000003"}'), 'applied', 'Alex makes a link for group 2');
SELECT is(pg_temp.join('dddddddd-dddd-dddd-dddd-dddddddddddd', 'peopletestinvitetoken0000000000000000000003', NULL, 'Kim'), '10000000-0000-0000-0000-000000000002'::UUID, 'Kim joins group 2 as a guest');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000a2"}'), 'applied', 'Alex, the only full member, leaves');

SELECT results_eq(
    $$ SELECT deleted_at IS NOT NULL, row_version, head_version FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000002' $$,
    $$ VALUES (TRUE, 4::BIGINT, 4::BIGINT) $$,
    'group 2 is deleted (soft) in the same version'
);
SELECT is(
    (SELECT role FROM public.group_members WHERE group_id = '10000000-0000-0000-0000-000000000002' AND deleted_at IS NULL),
    'guest',
    'the guest is still listed in it'
);
SELECT ok(
    (SELECT c->'groups'->0->>'deleted_at' IS NOT NULL
     FROM jsonb_array_elements(pg_temp.pull('dddddddd-dddd-dddd-dddd-dddddddddddd')->'changes') c
     WHERE c->>'group_id' = '10000000-0000-0000-0000-000000000002'),
    'the guest''s device receives the deleted group'
);
SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000d2", "displayName": "Kim"}'), 'HS403', 'nothing can change in a deleted group');

-- ---------------------------------------------------------------------------
-- The owner deletes a group
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000003", "memberId": "20000000-0000-0000-0000-0000000000a3", "name": "Old trip", "displayName": "Alex"}'), 'applied', 'Alex creates group 3');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.delete", "groupId": "10000000-0000-0000-0000-000000000003"}'), 'applied', 'the owner deletes it');
SELECT results_eq(
    $$ SELECT (c->'groups'->0->>'deleted_at') IS NOT NULL, (c->>'version')::BIGINT
       FROM jsonb_array_elements(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"10000000-0000-0000-0000-000000000003": 1}')->'changes') c $$,
    $$ VALUES (TRUE, 2::BIGINT) $$,
    'the deletion is a group row with deleted_at, at the next version'
);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.rename", "groupId": "10000000-0000-0000-0000-000000000003", "name": "Back"}'), 'HS403', 'a deleted group can''t be renamed');

SELECT * FROM finish();
ROLLBACK;
