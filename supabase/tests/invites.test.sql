-- ============================================================================
-- pgTAP tests for invites and joining (migration 007): invite.create and invite.revoke through
-- push_changes(), and the online functions preview_invite() (signed out too), join_group() and
-- upgrade_guest(), each called as the role a device would call it with. Everything is rolled back.
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
CREATE FUNCTION pg_temp.preview_signed_in(p_token TEXT) RETURNS JSONB LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.preview_invite(p_token);
$$;
CREATE FUNCTION pg_temp.upgrade_signed_in() RETURNS VOID LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.upgrade_guest();
$$;
CREATE FUNCTION pg_temp.sqlstate_signed_in(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql SET role = 'authenticated' AS $$
BEGIN
    EXECUTE p_sql;
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
END $$;
CREATE FUNCTION pg_temp.preview_signed_out(p_token TEXT) RETURNS JSONB LANGUAGE plpgsql SET role = 'anon' AS $$
BEGIN
    PERFORM set_config('request.jwt.claims', '{"role": "anon"}', true);
    RETURN public.preview_invite(p_token);
END $$;
CREATE FUNCTION pg_temp.sqlstate_signed_out(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql SET role = 'anon' AS $$
BEGIN
    PERFORM set_config('request.jwt.claims', '{"role": "anon"}', true);
    EXECUTE p_sql;
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
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
CREATE FUNCTION pg_temp.preview(p_user UUID, p_token TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.preview_signed_in(p_token);
END $$;
CREATE FUNCTION pg_temp.upgrade(p_user UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    PERFORM pg_temp.upgrade_signed_in();
END $$;
CREATE FUNCTION pg_temp.head(p_group UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT head_version FROM public.groups WHERE id = p_group;
$$;
CREATE FUNCTION pg_temp.invite(p_invite UUID, p_group UUID, p_token TEXT, p_claim UUID, p_expires TIMESTAMPTZ) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('type', 'invite.create', 'inviteId', p_invite, 'groupId', p_group, 'token', p_token, 'claimMemberId', p_claim, 'expiresAt', p_expires);
$$;

-- ---------------------------------------------------------------------------
-- Alex owns group 1 and has added Jo and Pat by name. Group 2 is Alex's too.
-- Users: aaaa… Alex, bbbb… Sam, cccc… Jo, dddd… Kim (anonymous), eeee… Lee, ffff… Ren.
-- Tokens are 43 characters: invites1test + digits.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@invites.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@invites.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'jo@invites.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Jo"}'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'lee@invites.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Lee"}'),
    ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'ren@invites.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Ren"}');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Banff", "displayName": "Alex"}'), 'applied', 'Alex creates group 1');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "Pat"}'), 'applied', 'Alex adds Pat by name');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000c1", "displayName": "Jo"}'), 'applied', 'Alex adds Jo by name');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000a2", "name": "Jasper", "displayName": "Alex"}'), 'applied', 'Alex creates group 2');

-- ---------------------------------------------------------------------------
-- Making a link: the server keeps only the token's hash
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.invite('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'invites1test0000000000000000000000000000001', '20000000-0000-0000-0000-0000000000f1', NOW() + INTERVAL '30 days')),
    'applied',
    'Alex makes a link for Pat, asking for 30 days'
);
SELECT results_eq(
    $$ SELECT token_hash, claim_member_id::TEXT, created_by::TEXT, expires_at, revoked_at, row_version FROM public.group_invites WHERE id = '50000000-0000-0000-0000-000000000001' $$,
    $$ VALUES (encode(sha256('invites1test0000000000000000000000000000001'::BYTEA), 'hex'), '20000000-0000-0000-0000-0000000000f1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
               NOW() + INTERVAL '14 days', NULL::TIMESTAMPTZ, 4::BIGINT) $$,
    'it stores the hex SHA-256 of the token, is for Pat, made by Alex, lasts 14 days at most, at version 4'
);
SELECT is(
    (SELECT count(*)::INT FROM public.group_invites i WHERE to_jsonb(i)::TEXT LIKE '%invites1test0000000000000000000000000000001%'),
    0,
    'the token itself is stored nowhere'
);
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.invite('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'invites1test0000000000000000000000000000002', NULL, NOW() + INTERVAL '2 days')),
    'applied',
    'Alex makes an open link that lasts 2 days'
);
SELECT is((SELECT expires_at FROM public.group_invites WHERE id = '50000000-0000-0000-0000-000000000002'), NOW() + INTERVAL '2 days', 'a shorter expiry is kept as sent');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.invite('50000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', 'short', NULL, NOW() + INTERVAL '1 day')), 'HS422', 'a token that isn''t 32 bytes in base64url is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.invite('50000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', 'invites1test0000000000000000000000000000009', '20000000-0000-0000-0000-0000000000a1', NOW() + INTERVAL '1 day')), 'HS422', 'a link can''t be for someone who has joined (Alex)');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.invite('50000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', 'invites1test0000000000000000000000000000009', '20000000-0000-0000-0000-0000000000a2', NOW() + INTERVAL '1 day')), 'HS422', 'a link can''t be for someone in another group');

SELECT is(
    (SELECT array_agg(k ORDER BY k)
     FROM jsonb_array_elements(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"10000000-0000-0000-0000-000000000001": 3}')->'changes') c,
         jsonb_object_keys(c->'invites'->0) k
     WHERE c->>'group_id' = '10000000-0000-0000-0000-000000000001'),
    ARRAY['claim_member_id', 'created_at', 'created_by', 'expires_at', 'group_id', 'id', 'revoked_at', 'row_version'],
    'invites are pulled with exactly these keys: never token_hash'
);
SELECT is(pg_temp.sqlstate_signed_in('SELECT token_hash FROM public.group_invites'), '42501', 'a device can''t select token_hash');
SELECT is(pg_temp.sqlstate_signed_in('SELECT id, expires_at FROM public.group_invites'), 'ok', '... but can select the other columns');

-- ---------------------------------------------------------------------------
-- Previewing works signed out
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.preview_signed_out('invites1test0000000000000000000000000000001'),
    '{"groupId": "10000000-0000-0000-0000-000000000001", "groupName": "Banff", "invitedBy": "Alex",
      "claimMemberId": "20000000-0000-0000-0000-0000000000f1",
      "unclaimed": [{"memberId": "20000000-0000-0000-0000-0000000000c1", "displayName": "Jo"}, {"memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "Pat"}],
      "alreadyMember": false}'::JSONB,
    'signed out, the link shows the group, who made it, who it is for, and the unclaimed names in order'
);
SELECT is(pg_temp.preview('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'invites1test0000000000000000000000000000001')->'alreadyMember', 'true'::JSONB, 'a member previewing it is told they are in already');
SELECT throws_ok($$ SELECT pg_temp.preview_signed_out('invites1test0000000000000000000000000000404') $$, 'HS404', NULL, 'an unknown token is not found');
SELECT is(pg_temp.sqlstate_signed_out($$ SELECT public.join_group('invites1test0000000000000000000000000000001') $$), '42501', 'joining needs signing in first');

-- ---------------------------------------------------------------------------
-- Joining
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.join('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'invites1test0000000000000000000000000000001'), '10000000-0000-0000-0000-000000000001'::UUID, 'Lee opens Pat''s link');
SELECT results_eq(
    $$ SELECT id::TEXT, user_id::TEXT, display_name, role, joined_at = NOW(), row_version FROM public.group_members WHERE user_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' $$,
    $$ VALUES ('20000000-0000-0000-0000-0000000000f1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Pat', 'member', TRUE, 6::BIGINT) $$,
    'whoever opens a link for a non-member becomes them: same member id and name, now joined, at the next version'
);
SELECT is(pg_temp.pull('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')->'group_ids', '["10000000-0000-0000-0000-000000000001"]'::JSONB, 'the group now reaches Lee''s device');

SELECT throws_ok(
    $$ SELECT pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'invites1test0000000000000000000000000000001', '20000000-0000-0000-0000-0000000000f1') $$,
    'HS422', 'Someone has already joined as that person',
    'a non-member who has been taken can''t be claimed again'
);
SELECT is(
    pg_temp.preview('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'invites1test0000000000000000000000000000001') - 'invitedBy' - 'groupName' - 'groupId',
    '{"claimMemberId": null, "unclaimed": [{"memberId": "20000000-0000-0000-0000-0000000000c1", "displayName": "Jo"}], "alreadyMember": false}'::JSONB,
    'once Pat is taken, the link offers only who is left'
);
SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'invites1test0000000000000000000000000000001', NULL, '  Sammy '), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam opens the same link, picks nobody and gives a name');
SELECT results_eq(
    $$ SELECT display_name, role FROM public.group_members WHERE user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' $$,
    $$ VALUES ('Sammy', 'member') $$,
    'Sam is added as someone new under that name'
);
SELECT is(pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'invites1test0000000000000000000000000000002'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam joins again, with the other link');
SELECT results_eq(
    $$ SELECT count(*)::INT, max(g.head_version) FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id WHERE gm.user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' $$,
    $$ VALUES (1, 7::BIGINT) $$,
    '... which does nothing: still one row, and no new version'
);

SELECT is(pg_temp.join('cccccccc-cccc-cccc-cccc-cccccccccccc', 'invites1test0000000000000000000000000000002', '20000000-0000-0000-0000-0000000000c1'), '10000000-0000-0000-0000-000000000001'::UUID, 'Jo opens the open link and picks Jo');
SELECT is((SELECT user_id::TEXT FROM public.group_members WHERE id = '20000000-0000-0000-0000-0000000000c1'), 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Jo takes over the Jo who was added by name');

SELECT is(pg_temp.join('ffffffff-ffff-ffff-ffff-ffffffffffff', 'invites1test0000000000000000000000000000002', NULL, '   '), '10000000-0000-0000-0000-000000000001'::UUID, 'Ren joins without giving a name');
SELECT is((SELECT display_name FROM public.group_members WHERE user_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'), 'Ren', 'Ren is named after their profile');

SELECT is(pg_temp.join('dddddddd-dddd-dddd-dddd-dddddddddddd', 'invites1test0000000000000000000000000000002', NULL, 'Kim'), '10000000-0000-0000-0000-000000000001'::UUID, 'Kim, signed in anonymously, joins');
SELECT is((SELECT role FROM public.group_members WHERE user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'guest', 'an anonymous caller joins as a guest');

-- ---------------------------------------------------------------------------
-- Coming back after leaving gives the old member row back, with its history
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1"}'),
    'applied',
    'Lee (as Pat) leaves'
);
SELECT is(pg_temp.join('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'invites1test0000000000000000000000000000002', NULL, 'Lee'), '10000000-0000-0000-0000-000000000001'::UUID, 'Lee comes back with the open link');
SELECT results_eq(
    $$ SELECT id::TEXT, display_name, deleted_at, role FROM public.group_members WHERE user_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' $$,
    $$ VALUES ('20000000-0000-0000-0000-0000000000f1', 'Pat', NULL::TIMESTAMPTZ, 'member') $$,
    'Lee gets the Pat row back rather than a new one'
);

-- ---------------------------------------------------------------------------
-- Expired and revoked links stop working
-- ---------------------------------------------------------------------------
-- Day 15 for the first link: move its dates back as if it had been made 15 days ago.
UPDATE public.group_invites SET created_at = created_at - INTERVAL '15 days', expires_at = expires_at - INTERVAL '15 days'
WHERE id = '50000000-0000-0000-0000-000000000001';
SELECT throws_ok($$ SELECT pg_temp.preview_signed_out('invites1test0000000000000000000000000000001') $$, 'HS404', NULL, 'on day 15 the link no longer previews');
SELECT throws_ok($$ SELECT pg_temp.join('ffffffff-ffff-ffff-ffff-ffffffffffff', 'invites1test0000000000000000000000000000001') $$, 'HS404', NULL, '... or joins');

SELECT is(pg_temp.try('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{"type": "invite.revoke", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000002"}'), 'HS403', 'a member can''t revoke a link');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.revoke", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000002"}'), 'applied', 'the owner revokes the open link');
SELECT results_eq(
    $$ SELECT revoked_at IS NOT NULL, row_version = (SELECT head_version FROM public.groups WHERE id = group_id) FROM public.group_invites WHERE id = '50000000-0000-0000-0000-000000000002' $$,
    $$ VALUES (TRUE, TRUE) $$,
    'it is revoked at the next version, so devices pull the change'
);
SELECT throws_ok($$ SELECT pg_temp.preview_signed_out('invites1test0000000000000000000000000000002') $$, 'HS404', NULL, 'a revoked link no longer previews');
SELECT throws_ok($$ SELECT pg_temp.join('ffffffff-ffff-ffff-ffff-ffffffffffff', 'invites1test0000000000000000000000000000002') $$, 'HS404', NULL, '... or joins (even for someone already in)');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.revoke", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000002"}'), 'applied', 'revoking it again is accepted');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.revoke", "groupId": "10000000-0000-0000-0000-000000000001", "inviteId": "50000000-0000-0000-0000-000000000077"}'), 'applied', 'revoking a link the server never stored is accepted');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "invite.revoke", "groupId": "10000000-0000-0000-0000-000000000002", "inviteId": "50000000-0000-0000-0000-000000000001"}'), 'HS422', 'a link can''t be revoked through another group');

-- ---------------------------------------------------------------------------
-- A guest who adds an email becomes a member everywhere, keeping their rows
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.invite('50000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'invites1test0000000000000000000000000000003', NULL, NOW() + INTERVAL '14 days')),
    'applied',
    'Alex makes a link for group 2'
);
SELECT is(pg_temp.join('dddddddd-dddd-dddd-dddd-dddddddddddd', 'invites1test0000000000000000000000000000003', NULL, 'Kim'), '10000000-0000-0000-0000-000000000002'::UUID, 'Kim joins group 2 as a guest too');

SELECT throws_ok($$ SELECT pg_temp.upgrade('dddddddd-dddd-dddd-dddd-dddddddddddd') $$, 'HS403', NULL, 'a guest without an email can''t upgrade');

-- What Supabase Auth does when Kim adds an email and enters the code: same user, no longer anonymous.
UPDATE auth.users SET email = 'kim@invites.test', is_anonymous = FALSE WHERE id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
SELECT lives_ok($$ SELECT pg_temp.upgrade('dddddddd-dddd-dddd-dddd-dddddddddddd') $$, 'with an email, Kim upgrades');
SELECT results_eq(
    $$ SELECT group_id::TEXT, role, row_version = (SELECT head_version FROM public.groups WHERE id = group_id) FROM public.group_members
       WHERE user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' ORDER BY group_id $$,
    $$ VALUES ('10000000-0000-0000-0000-000000000001', 'member', TRUE), ('10000000-0000-0000-0000-000000000002', 'member', TRUE) $$,
    'both of Kim''s guest rows are now member rows, the same rows, each at its group''s next version'
);
SELECT is((SELECT email FROM public.profiles WHERE id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'kim@invites.test', 'the email is copied into Kim''s profile');
SELECT is(
    (SELECT c->'members' FROM jsonb_array_elements(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('10000000-0000-0000-0000-000000000002', pg_temp.head('10000000-0000-0000-0000-000000000002') - 1))->'changes') c
     WHERE c->>'group_id' = '10000000-0000-0000-0000-000000000002') @> '[{"display_name": "Kim", "role": "member"}]'::JSONB,
    TRUE,
    'other devices pull the new role'
);

SELECT * FROM finish();
ROLLBACK;
