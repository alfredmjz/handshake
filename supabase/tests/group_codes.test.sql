-- ============================================================================
-- pgTAP tests for group codes and personal codes (migration 012): unique names through push_changes(),
-- group.recode, preview_group() (signed out too), join_with_code() (new name, a name-only person, coming back
-- with a personal code), who can read guest codes (directly and through pull_changes()), and personal codes
-- going away when a guest adds an email, is completed out, or comes back with an email login. Everything is
-- rolled back. Codes are random, so expectations read them from the table.
-- ============================================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

-- ---------------------------------------------------------------------------
-- Helpers
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
CREATE FUNCTION pg_temp.join_signed_in(p_code TEXT, p_claim UUID, p_name TEXT, p_personal TEXT) RETURNS UUID LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.join_with_code(p_code, p_claim, p_name, p_personal);
$$;
CREATE FUNCTION pg_temp.preview_signed_in(p_code TEXT) RETURNS JSONB LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.preview_group(p_code);
$$;
CREATE FUNCTION pg_temp.upgrade_signed_in() RETURNS VOID LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.upgrade_guest();
$$;
CREATE FUNCTION pg_temp.codes_signed_in() RETURNS TEXT[] LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT COALESCE(array_agg(member_id::TEXT ORDER BY member_id), '{}') FROM public.guest_codes;
$$;
CREATE FUNCTION pg_temp.preview_signed_out(p_code TEXT) RETURNS JSONB LANGUAGE plpgsql SET role = 'anon' AS $$
BEGIN
    PERFORM set_config('request.jwt.claims', '{"role": "anon"}', true);
    RETURN public.preview_group(p_code);
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
-- 'applied', or the rejection's code and reason.
CREATE FUNCTION pg_temp.try(p_user UUID, p_mutation JSONB) RETURNS TEXT LANGUAGE sql AS $$
    SELECT COALESCE((r#>>'{rejected,0,code}') || ' ' || (r#>>'{rejected,0,reason}'), 'applied') FROM pg_temp.push(p_user, p_mutation) r;
$$;
CREATE FUNCTION pg_temp.pull(p_user UUID, p_cursors JSONB DEFAULT '{}') RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.pull_signed_in(p_cursors);
END $$;
CREATE FUNCTION pg_temp.join(p_user UUID, p_code TEXT, p_claim UUID DEFAULT NULL, p_name TEXT DEFAULT NULL, p_personal TEXT DEFAULT NULL) RETURNS UUID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.join_signed_in(p_code, p_claim, p_name, p_personal);
END $$;
-- 'ok', or the error's SQLSTATE and message.
CREATE FUNCTION pg_temp.join_error(p_user UUID, p_code TEXT, p_claim UUID DEFAULT NULL, p_name TEXT DEFAULT NULL, p_personal TEXT DEFAULT NULL) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.join(p_user, p_code, p_claim, p_name, p_personal);
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE || ' ' || SQLERRM;
END $$;
CREATE FUNCTION pg_temp.preview(p_user UUID, p_code TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.preview_signed_in(p_code);
END $$;
CREATE FUNCTION pg_temp.preview_error(p_code TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.preview_signed_out(p_code);
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE || ' ' || SQLERRM;
END $$;
CREATE FUNCTION pg_temp.upgrade(p_user UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    PERFORM pg_temp.upgrade_signed_in();
END $$;
-- The member ids whose guest codes p_user can SELECT.
CREATE FUNCTION pg_temp.visible_codes(p_user UUID) RETURNS TEXT[] LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.codes_signed_in();
END $$;
CREATE FUNCTION pg_temp.head(p_group UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT head_version FROM public.groups WHERE id = p_group;
$$;
CREATE FUNCTION pg_temp.code(p_group UUID) RETURNS TEXT LANGUAGE sql AS $$
    SELECT join_code FROM public.groups WHERE id = p_group;
$$;
CREATE FUNCTION pg_temp.guest_code(p_member UUID) RETURNS TEXT LANGUAGE sql AS $$
    SELECT code FROM public.guest_codes WHERE member_id = p_member AND deleted_at IS NULL;
$$;
-- As someone types it: lower case, with the dash.
CREATE FUNCTION pg_temp.typed(p_code TEXT) RETURNS TEXT LANGUAGE sql AS $$
    SELECT lower(substr(p_code, 1, 3)) || '-' || lower(substr(p_code, 4));
$$;
-- The member ids in a pulled group change's guest_codes, sorted.
CREATE FUNCTION pg_temp.pulled_codes(p_pull JSONB, p_group UUID) RETURNS TEXT[] LANGUAGE sql AS $$
    SELECT COALESCE(array_agg(gc->>'member_id' ORDER BY gc->>'member_id'), '{}')
    FROM jsonb_array_elements(p_pull->'changes') c, jsonb_array_elements(c->'guest_codes') gc
    WHERE c->>'group_id' = p_group::TEXT;
$$;
CREATE FUNCTION pg_temp.names(p_list JSONB) RETURNS TEXT[] LANGUAGE sql AS $$
    SELECT COALESCE(array_agg(x->>'displayName' ORDER BY ord), '{}') FROM jsonb_array_elements(p_list) WITH ORDINALITY AS t(x, ord);
$$;

-- ---------------------------------------------------------------------------
-- Users: aaaa… Alex, bbbb… Sam, eeee… Lee (emails); cccc… Kim, dddd… Kim's new phone, ffff… Ren,
-- 1111… Mo, 2222… Bo, 3333… Vi (anonymous).
-- Alex owns group 1 (Banff, member a1) and group 2 (Jasper, a2), and adds Pat (f1) and Jo (c1) to group 1.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@codes.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@codes.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'lee@codes.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Lee"}'),
    ('ffffffff-ffff-ffff-ffff-ffffffffffff', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('11111111-1111-1111-1111-111111111111', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('22222222-2222-2222-2222-222222222222', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('33333333-3333-3333-3333-333333333333', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Banff", "displayName": "Alex"}'), 'applied', 'Alex creates group 1');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "Pat"}'), 'applied', 'Alex adds Pat by name');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000c1", "displayName": "Jo"}'), 'applied', 'Alex adds Jo by name');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000a2", "name": "Jasper", "displayName": "Alex"}'), 'applied', 'Alex creates group 2');

-- ---------------------------------------------------------------------------
-- Group codes are made on the server
-- ---------------------------------------------------------------------------
SELECT ok(pg_temp.code('10000000-0000-0000-0000-000000000001') ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$', 'group 1 has a 6-character code from the alphabet without lookalikes');
SELECT ok(pg_temp.code('10000000-0000-0000-0000-000000000002') ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$', 'so does group 2');
SELECT isnt(pg_temp.code('10000000-0000-0000-0000-000000000001'), pg_temp.code('10000000-0000-0000-0000-000000000002'), 'the two codes differ');
SELECT is(
    (SELECT g->>'join_code' FROM jsonb_array_elements(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->'changes') c, jsonb_array_elements(c->'groups') g WHERE g->>'id' = '10000000-0000-0000-0000-000000000001'),
    pg_temp.code('10000000-0000-0000-0000-000000000001'),
    'the owner pulls the code with the group'
);
SELECT throws_ok(
    $$ UPDATE public.groups SET join_code = 'ABC10O' WHERE id = '10000000-0000-0000-0000-000000000002' $$,
    '23514', NULL, 'a code with lookalikes (1, 0, O) is refused by the table'
);

-- ---------------------------------------------------------------------------
-- Names are unique per group, ignoring case and spaces
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e1", "displayName": "pat"}'), 'HS409 pat is already in this group', 'adding "pat" next to Pat is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e1", "displayName": "  ALEX "}'), 'HS409 ALEX is already in this group', 'so is "  ALEX " next to the owner (trimmed in the reason)');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e1", "displayName": "Kai"}'), 'applied', 'Kai is new');
SELECT is(
    (SELECT r#>>'{rejected,0,code}' FROM pg_temp.push('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e1", "displayName": "Kai"}') r),
    '23505',
    'adding Kai again under the same member id is still the duplicate id (23505), not a name clash'
);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e1", "displayName": "JO"}'), 'HS409 JO is already in this group', 'renaming Kai to "JO" is refused');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "PAT"}'), 'applied', 'Pat can be renamed to "PAT" (the same name)');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "Pat"}'), 'applied', 'and back to "Pat"');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e1"}'), 'applied', 'Alex removes Kai');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000e2", "displayName": "Kai"}'), 'applied', 'someone who left doesn''t hold their name: a new Kai can be added');

-- Two people already named Dee (from before 012) stay; renaming either to the same name is not a change.
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000d1", "displayName": "Dee"}'), 'applied', 'Alex adds Dee');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.add", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000d2", "displayName": "Dot"}'), 'applied', 'Alex adds Dot');
UPDATE public.group_members SET display_name = 'Dee' WHERE id = '20000000-0000-0000-0000-0000000000d2';
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000d2", "displayName": "DEE "}'), 'applied', 'an old duplicate can keep its name (here "DEE ")');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.rename", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000d2", "displayName": "Dot"}'), 'applied', 'and can move to a free name');

-- ---------------------------------------------------------------------------
-- preview_group
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.preview_signed_out(pg_temp.typed(pg_temp.code('10000000-0000-0000-0000-000000000001'))),
    jsonb_build_object(
        'groupId', '10000000-0000-0000-0000-000000000001',
        'groupName', 'Banff',
        'ownerName', 'Alex',
        'unclaimed', '[{"memberId": "20000000-0000-0000-0000-0000000000d1", "displayName": "Dee"}, {"memberId": "20000000-0000-0000-0000-0000000000d2", "displayName": "Dot"}, {"memberId": "20000000-0000-0000-0000-0000000000c1", "displayName": "Jo"}, {"memberId": "20000000-0000-0000-0000-0000000000e2", "displayName": "Kai"}, {"memberId": "20000000-0000-0000-0000-0000000000f1", "displayName": "Pat"}]'::JSONB,
        'returning', '[]'::JSONB,
        'alreadyMember', FALSE
    ),
    'signed out, the code typed in lower case with its dash shows the group, its owner and the name-only people by name (Kai who left is not there)'
);
SELECT is(pg_temp.preview_error('ZZZZZZ'), 'HS404 This code doesn''t work', 'an unknown code is HS404');
SELECT is(pg_temp.preview_error(''), 'HS404 This code doesn''t work', 'so is an empty one');
SELECT is((pg_temp.preview('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.code('10000000-0000-0000-0000-000000000001'))->>'alreadyMember')::BOOLEAN, TRUE, 'Alex is already a member');
SELECT is(pg_temp.sqlstate_signed_out($$ SELECT public.join_with_code('ABCDEF') $$), '42501', 'signed out, join_with_code can''t be called');

-- ---------------------------------------------------------------------------
-- Joining: a name-only person, someone new, a member with an email
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.join('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.typed(pg_temp.code('10000000-0000-0000-0000-000000000001')), '20000000-0000-0000-0000-0000000000c1'),
    '10000000-0000-0000-0000-000000000001'::UUID,
    'Kim (a guest) joins group 1 as Jo and gets the group id back'
);
SELECT results_eq(
    $$ SELECT user_id::TEXT, role, joined_at IS NOT NULL, row_version FROM public.group_members WHERE id = '20000000-0000-0000-0000-0000000000c1' $$,
    $$ VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'guest', TRUE, pg_temp.head('10000000-0000-0000-0000-000000000001')) $$,
    'Jo is now Kim''s login, a guest, joined, at the group''s latest version'
);
SELECT results_eq(
    $$ SELECT group_id::TEXT, code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$', deleted_at IS NULL, row_version FROM public.guest_codes WHERE member_id = '20000000-0000-0000-0000-0000000000c1' $$,
    $$ VALUES ('10000000-0000-0000-0000-000000000001', TRUE, TRUE, pg_temp.head('10000000-0000-0000-0000-000000000001')) $$,
    'Jo has a personal code, stamped with the same version'
);

SELECT is(
    pg_temp.join_error('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', pg_temp.code('10000000-0000-0000-0000-000000000001'), NULL, ' pat'),
    'HS409 pat is already in this group',
    'Lee can''t join as someone new called " pat"'
);
SELECT is(
    pg_temp.join_error('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', pg_temp.code('10000000-0000-0000-0000-000000000001'), '20000000-0000-0000-0000-0000000000c1'),
    'HS422 Someone has already joined as that person',
    'nor pick Jo, whom Kim has joined as'
);
SELECT is(
    pg_temp.join_error('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', pg_temp.code('10000000-0000-0000-0000-000000000001'), '20000000-0000-0000-0000-0000000000e1'),
    'HS422 That person is not in this group',
    'nor Kai who left'
);
SELECT is(
    pg_temp.join('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', pg_temp.code('10000000-0000-0000-0000-000000000001'), NULL, 'Lee'),
    '10000000-0000-0000-0000-000000000001'::UUID,
    'Lee joins as someone new called Lee'
);
SELECT results_eq(
    $$ SELECT role, joined_at IS NOT NULL, (SELECT count(*)::INT FROM public.guest_codes c WHERE c.member_id = gm.id)
       FROM public.group_members gm WHERE user_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' $$,
    $$ VALUES ('member', TRUE, 0) $$,
    'Lee (with an email) is a member, joined, with no personal code'
);
SELECT pg_temp.head('10000000-0000-0000-0000-000000000001') AS before_again \gset
SELECT is(
    pg_temp.join('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', pg_temp.code('10000000-0000-0000-0000-000000000001'), NULL, 'Someone else'),
    '10000000-0000-0000-0000-000000000001'::UUID,
    'joining again returns the group'
);
SELECT is(pg_temp.head('10000000-0000-0000-0000-000000000001'), :before_again::BIGINT, 'and changes nothing');

SELECT is(
    pg_temp.join('ffffffff-ffff-ffff-ffff-ffffffffffff', pg_temp.code('10000000-0000-0000-0000-000000000001'), NULL, ' Ren '),
    '10000000-0000-0000-0000-000000000001'::UUID,
    'Ren (a guest) joins as someone new called " Ren "'
);
SELECT results_eq(
    $$ SELECT gm.display_name, gm.role, c.row_version = gm.row_version FROM public.group_members gm JOIN public.guest_codes c ON c.member_id = gm.id
       WHERE gm.user_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff' $$,
    $$ VALUES ('Ren', 'guest', TRUE) $$,
    'Ren is a guest named "Ren" with a personal code from the same version'
);
SELECT isnt(
    pg_temp.guest_code('20000000-0000-0000-0000-0000000000c1'),
    (SELECT code FROM public.guest_codes c JOIN public.group_members gm ON gm.id = c.member_id WHERE gm.user_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
    'Jo''s and Ren''s codes differ'
);
SELECT is(
    pg_temp.names(pg_temp.preview('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.code('10000000-0000-0000-0000-000000000001'))->'returning'),
    ARRAY['Jo', 'Ren'],
    'the preview now lists the guests with a personal code, by name, for "I''m already in this group"'
);
SELECT is(
    pg_temp.names(pg_temp.preview('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.code('10000000-0000-0000-0000-000000000001'))->'unclaimed'),
    ARRAY['Dee', 'Dot', 'Kai', 'Pat'],
    'and Jo is no longer unclaimed'
);

-- ---------------------------------------------------------------------------
-- Who can read guest codes
-- ---------------------------------------------------------------------------
SELECT (SELECT id::TEXT FROM public.group_members WHERE user_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff') AS ren \gset
SELECT is(
    pg_temp.pulled_codes(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), '10000000-0000-0000-0000-000000000001'),
    (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY['20000000-0000-0000-0000-0000000000c1', :'ren']) x),
    'the owner pulls every guest code in the group'
);
SELECT is(
    pg_temp.visible_codes('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY['20000000-0000-0000-0000-0000000000c1', :'ren']) x),
    'and can SELECT them'
);
SELECT is(pg_temp.pulled_codes(pg_temp.pull('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), '10000000-0000-0000-0000-000000000001'), '{}'::TEXT[], 'a member pulls no guest codes');
SELECT is(pg_temp.visible_codes('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), '{}'::TEXT[], 'and can SELECT none');
SELECT is(pg_temp.pulled_codes(pg_temp.pull('cccccccc-cccc-cccc-cccc-cccccccccccc'), '10000000-0000-0000-0000-000000000001'), ARRAY['20000000-0000-0000-0000-0000000000c1'], 'Kim pulls only Jo''s code (her own)');
SELECT is(pg_temp.visible_codes('cccccccc-cccc-cccc-cccc-cccccccccccc'), ARRAY['20000000-0000-0000-0000-0000000000c1'], 'and can SELECT only that one');
SELECT is(pg_temp.visible_codes('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), '{}'::TEXT[], 'Sam, in no group, sees none');
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_array_elements(pg_temp.pull('cccccccc-cccc-cccc-cccc-cccccccccccc')->'changes') c, jsonb_object_keys(c->'guest_codes'->0) k),
    ARRAY['code', 'created_at', 'deleted_at', 'group_id', 'member_id', 'row_version'],
    'a pulled guest code has exactly these keys'
);
SELECT is(
    (SELECT gc->>'code' FROM jsonb_array_elements(pg_temp.pull('cccccccc-cccc-cccc-cccc-cccccccccccc')->'changes') c, jsonb_array_elements(c->'guest_codes') gc),
    pg_temp.guest_code('20000000-0000-0000-0000-0000000000c1'),
    'carrying the code itself'
);
SELECT is(
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.pull('cccccccc-cccc-cccc-cccc-cccccccccccc')) k),
    ARRAY['changes', 'group_ids', 'moved_away'],
    'a pull has exactly these keys'
);

-- ---------------------------------------------------------------------------
-- Coming back with a personal code
-- ---------------------------------------------------------------------------
SELECT pg_temp.guest_code('20000000-0000-0000-0000-0000000000c1') AS jo_code \gset
SELECT is(
    pg_temp.join_error('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.code('10000000-0000-0000-0000-000000000001'), '20000000-0000-0000-0000-0000000000c1', NULL, CASE WHEN :'jo_code' = 'AAAAAA' THEN 'BBBBBB' ELSE 'AAAAAA' END),
    'HS422 That code doesn''t match',
    'Kim''s new phone with the wrong personal code is refused'
);
SELECT is(
    pg_temp.join_error('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.code('10000000-0000-0000-0000-000000000001'), '20000000-0000-0000-0000-0000000000f1', NULL, :'jo_code'),
    'HS422 That code doesn''t match',
    'Jo''s code doesn''t open Pat (a name-only person has none)'
);
SELECT is(
    pg_temp.join_error('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.code('10000000-0000-0000-0000-000000000001'), (SELECT id FROM public.group_members WHERE user_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), NULL, :'jo_code'),
    'HS422 Sign in with your email to get back in',
    'a member with an email can''t be taken with a code'
);
SELECT is(
    pg_temp.join_error('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.code('10000000-0000-0000-0000-000000000001'), NULL, NULL, :'jo_code'),
    'HS422 That person is not in this group',
    'a personal code needs a name picked'
);
SELECT is(
    pg_temp.join('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.code('10000000-0000-0000-0000-000000000001'), '20000000-0000-0000-0000-0000000000c1', NULL, pg_temp.typed(:'jo_code')),
    '10000000-0000-0000-0000-000000000001'::UUID,
    'with Jo''s code (typed in lower case with a dash), Kim''s new phone comes back as Jo'
);
SELECT results_eq(
    $$ SELECT user_id::TEXT, role, row_version FROM public.group_members WHERE id = '20000000-0000-0000-0000-0000000000c1' $$,
    $$ VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'guest', pg_temp.head('10000000-0000-0000-0000-000000000001')) $$,
    'Jo''s row moved to the new login, still a guest, at the latest version'
);
SELECT is(pg_temp.guest_code('20000000-0000-0000-0000-0000000000c1'), :'jo_code', 'Jo keeps the same personal code');
SELECT is(pg_temp.pull('cccccccc-cccc-cccc-cccc-cccccccccccc')->'group_ids', '[]'::JSONB, 'Kim''s old login no longer pulls the group');
SELECT is(pg_temp.pull('cccccccc-cccc-cccc-cccc-cccccccccccc')->'moved_away', '["10000000-0000-0000-0000-000000000001"]'::JSONB, 'and is told it moved away');
SELECT is(pg_temp.visible_codes('cccccccc-cccc-cccc-cccc-cccccccccccc'), '{}'::TEXT[], 'nor can it read Jo''s code any more');
SELECT is(pg_temp.pulled_codes(pg_temp.pull('dddddddd-dddd-dddd-dddd-dddddddddddd'), '10000000-0000-0000-0000-000000000001'), ARRAY['20000000-0000-0000-0000-0000000000c1'], 'the new phone pulls Jo''s code');
SELECT is(pg_temp.pull('dddddddd-dddd-dddd-dddd-dddddddddddd')->'moved_away', '[]'::JSONB, 'and nothing moved away from it');
SELECT is(pg_temp.pull('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')->'moved_away', '[]'::JSONB, 'Lee, removed from nothing, has nothing moved away');

-- ---------------------------------------------------------------------------
-- group.recode: the owner only, not while completed
-- ---------------------------------------------------------------------------
SELECT pg_temp.code('10000000-0000-0000-0000-000000000001') AS old_code \gset
SELECT is(pg_temp.try('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '{"type": "group.recode", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'HS403 Only the group''s owner can do this', 'a member can''t reset the code');
SELECT is(pg_temp.try('dddddddd-dddd-dddd-dddd-dddddddddddd', '{"type": "group.recode", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'HS403 Only the group''s owner can do this', 'nor can a guest');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.recode", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'the owner resets it');
SELECT isnt(pg_temp.code('10000000-0000-0000-0000-000000000001'), :'old_code', 'the group has a new code');
SELECT is(
    (SELECT row_version FROM public.groups WHERE id = '10000000-0000-0000-0000-000000000001'),
    pg_temp.head('10000000-0000-0000-0000-000000000001'),
    'stamped with a new version, so devices pull it'
);
SELECT is(pg_temp.preview_error(:'old_code'), 'HS404 This code doesn''t work', 'the old code stops working');
SELECT is(pg_temp.join_error('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', :'old_code', NULL, 'Sam'), 'HS404 This code doesn''t work', 'for joining too');
SELECT is(pg_temp.preview_error(pg_temp.code('10000000-0000-0000-0000-000000000001')), 'ok', 'the new one works');

-- ---------------------------------------------------------------------------
-- Completing: the code stops working and guests' personal codes go; reopening brings the code back
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.complete", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'Alex completes group 1');
SELECT is(pg_temp.preview_error(pg_temp.code('10000000-0000-0000-0000-000000000001')), 'HS404 This code doesn''t work', 'a completed group''s code shows nothing');
SELECT is(pg_temp.join_error('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.code('10000000-0000-0000-0000-000000000001'), NULL, 'Sam'), 'HS404 This code doesn''t work', 'and lets no one join');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.recode", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'HS403 This group is completed', 'nor can it be reset');
SELECT results_eq(
    $$ SELECT count(*)::INT, bool_and(c.deleted_at IS NOT NULL), bool_and(c.row_version = pg_temp.head('10000000-0000-0000-0000-000000000001'))
       FROM public.guest_codes c WHERE c.group_id = '10000000-0000-0000-0000-000000000001' $$,
    $$ VALUES (2, TRUE, TRUE) $$,
    'Jo''s and Ren''s personal codes are deleted with the completion''s version'
);
SELECT is(
    (SELECT count(*)::INT FROM jsonb_array_elements(pg_temp.pull('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', jsonb_build_object('10000000-0000-0000-0000-000000000001', pg_temp.head('10000000-0000-0000-0000-000000000001') - 1))->'changes') c,
        jsonb_array_elements(c->'guest_codes') gc WHERE gc->>'deleted_at' IS NOT NULL),
    2,
    'the owner''s device pulls both deletions'
);
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.reopen", "groupId": "10000000-0000-0000-0000-000000000001"}'), 'applied', 'Alex reopens it');
SELECT is(
    pg_temp.preview('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.code('10000000-0000-0000-0000-000000000001'))->'returning',
    '[]'::JSONB,
    'the code works again; no one has a personal code'
);
SELECT is(
    pg_temp.names(pg_temp.preview('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.code('10000000-0000-0000-0000-000000000001'))->'unclaimed'),
    ARRAY['Dee', 'Dot', 'Jo', 'Kai', 'Pat', 'Ren'],
    'Jo and Ren are name-only people again'
);

-- ---------------------------------------------------------------------------
-- Group 2: adding an email drops the personal code; coming back as a login with an email too
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.join('11111111-1111-1111-1111-111111111111', pg_temp.code('10000000-0000-0000-0000-000000000002'), NULL, 'Mo'), '10000000-0000-0000-0000-000000000002'::UUID, 'Mo (a guest) joins group 2');
UPDATE auth.users SET email = 'mo@codes.test', is_anonymous = FALSE WHERE id = '11111111-1111-1111-1111-111111111111';
SELECT lives_ok($$ SELECT pg_temp.upgrade('11111111-1111-1111-1111-111111111111') $$, 'Mo adds an email');
SELECT results_eq(
    $$ SELECT gm.role, c.deleted_at IS NOT NULL, c.row_version = gm.row_version
       FROM public.group_members gm JOIN public.guest_codes c ON c.member_id = gm.id WHERE gm.user_id = '11111111-1111-1111-1111-111111111111' $$,
    $$ VALUES ('member', TRUE, TRUE) $$,
    'Mo is a member and their personal code is deleted in the same version'
);

SELECT is(pg_temp.join('22222222-2222-2222-2222-222222222222', pg_temp.code('10000000-0000-0000-0000-000000000002'), NULL, 'Bo'), '10000000-0000-0000-0000-000000000002'::UUID, 'Bo (a guest) joins group 2');
SELECT (SELECT id::TEXT FROM public.group_members WHERE user_id = '22222222-2222-2222-2222-222222222222') AS bo \gset
SELECT is(
    pg_temp.join('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', pg_temp.code('10000000-0000-0000-0000-000000000002'), :'bo'::UUID, NULL, pg_temp.guest_code(:'bo'::UUID)),
    '10000000-0000-0000-0000-000000000002'::UUID,
    'Bo comes back signed in with an email (Sam''s login)'
);
SELECT results_eq(
    $$ SELECT gm.user_id::TEXT, gm.role, c.deleted_at IS NOT NULL FROM public.group_members gm JOIN public.guest_codes c ON c.member_id = gm.id WHERE gm.id = (SELECT id FROM public.group_members WHERE display_name = 'Bo') $$,
    $$ VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member', TRUE) $$,
    'Bo''s row is now a member with Sam''s login, and the personal code is gone'
);
SELECT is(pg_temp.pull('22222222-2222-2222-2222-222222222222')->'moved_away', '["10000000-0000-0000-0000-000000000002"]'::JSONB, 'Bo''s old guest login is told it moved away');

-- A guest who leaves and joins again keeps their row and their code.
SELECT is(pg_temp.join('33333333-3333-3333-3333-333333333333', pg_temp.code('10000000-0000-0000-0000-000000000002'), NULL, 'Vi'), '10000000-0000-0000-0000-000000000002'::UUID, 'Vi (a guest) joins group 2');
SELECT (SELECT id::TEXT FROM public.group_members WHERE user_id = '33333333-3333-3333-3333-333333333333') AS vi \gset
SELECT pg_temp.guest_code(:'vi'::UUID) AS vi_code \gset
SELECT is(pg_temp.try('33333333-3333-3333-3333-333333333333', jsonb_build_object('type', 'member.remove', 'groupId', '10000000-0000-0000-0000-000000000002', 'memberId', :'vi')), 'applied', 'Vi leaves');
SELECT is(pg_temp.preview('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', pg_temp.code('10000000-0000-0000-0000-000000000002'))->'returning', '[]'::JSONB, 'someone who left is not offered for coming back');
SELECT is(pg_temp.join('33333333-3333-3333-3333-333333333333', pg_temp.code('10000000-0000-0000-0000-000000000002'), NULL, 'Someone'), '10000000-0000-0000-0000-000000000002'::UUID, 'Vi joins again');
SELECT is(
    (SELECT id::TEXT || ' ' || display_name || ' ' || (deleted_at IS NULL) FROM public.group_members WHERE user_id = '33333333-3333-3333-3333-333333333333'),
    :'vi' || ' Vi true',
    'as their old row, named Vi, active'
);
SELECT is(pg_temp.guest_code(:'vi'::UUID), :'vi_code', 'with the same personal code');

-- A new owner pulls the guest codes too. Everyone here joined at the same NOW(); Mo is made the first.
UPDATE public.group_members SET joined_at = NOW() - INTERVAL '1 hour'
WHERE user_id = '11111111-1111-1111-1111-111111111111' AND group_id = '10000000-0000-0000-0000-000000000002';
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "member.remove", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000a2"}'), 'applied', 'Alex leaves group 2');
SELECT is((SELECT role FROM public.group_members WHERE user_id = '11111111-1111-1111-1111-111111111111' AND group_id = '10000000-0000-0000-0000-000000000002'), 'owner', 'Mo, the first full member to join, owns it now');
SELECT is(
    (SELECT bool_and(row_version = pg_temp.head('10000000-0000-0000-0000-000000000002')) FROM public.guest_codes WHERE group_id = '10000000-0000-0000-0000-000000000002'),
    TRUE,
    'every guest code in group 2 is stamped with the hand-over''s version'
);
SELECT is(
    pg_temp.pulled_codes(pg_temp.pull('11111111-1111-1111-1111-111111111111', jsonb_build_object('10000000-0000-0000-0000-000000000002', pg_temp.head('10000000-0000-0000-0000-000000000002') - 1)), '10000000-0000-0000-0000-000000000002'),
    (SELECT array_agg(member_id::TEXT ORDER BY member_id) FROM public.guest_codes WHERE group_id = '10000000-0000-0000-0000-000000000002'),
    'so Mo''s device, already past them, pulls them all'
);

SELECT * FROM finish();
ROLLBACK;
