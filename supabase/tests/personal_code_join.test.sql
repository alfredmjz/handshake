-- ============================================================================
-- pgTAP tests for getting back in with a personal code alone (migration 013): 8-character personal codes,
-- unique across groups and apart from group codes; preview_code() telling a group code from a personal code
-- (signed out too); return_with_code() moving the guest's row to the caller, with the moved-away notice for
-- the login it left; the codes that don't work (unknown, left, upgraded, deleted or completed group); the
-- come-back path of join_with_code with 8-character codes; and replacing old 6-character codes. Everything
-- is rolled back. Codes are random, so expectations read them from the table.
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
CREATE FUNCTION pg_temp.return_signed_in(p_code TEXT) RETURNS UUID LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.return_with_code(p_code);
$$;
CREATE FUNCTION pg_temp.preview_signed_in(p_code TEXT) RETURNS JSONB LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.preview_code(p_code);
$$;
CREATE FUNCTION pg_temp.upgrade_signed_in() RETURNS VOID LANGUAGE sql SET role = 'authenticated' AS $$
    SELECT public.upgrade_guest();
$$;
CREATE FUNCTION pg_temp.preview_signed_out(p_code TEXT) RETURNS JSONB LANGUAGE plpgsql SET role = 'anon' AS $$
BEGIN
    PERFORM set_config('request.jwt.claims', '{"role": "anon"}', true);
    RETURN public.preview_code(p_code);
END $$;
CREATE FUNCTION pg_temp.group_preview_signed_out(p_code TEXT) RETURNS JSONB LANGUAGE plpgsql SET role = 'anon' AS $$
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
CREATE FUNCTION pg_temp.join_error(p_user UUID, p_code TEXT, p_claim UUID DEFAULT NULL, p_name TEXT DEFAULT NULL, p_personal TEXT DEFAULT NULL) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.join(p_user, p_code, p_claim, p_name, p_personal);
    RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE || ' ' || SQLERRM;
END $$;
CREATE FUNCTION pg_temp.return(p_user UUID, p_code TEXT) RETURNS UUID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.sign_in(p_user);
    RETURN pg_temp.return_signed_in(p_code);
END $$;
CREATE FUNCTION pg_temp.return_error(p_user UUID, p_code TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.return(p_user, p_code);
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
CREATE FUNCTION pg_temp.head(p_group UUID) RETURNS BIGINT LANGUAGE sql AS $$
    SELECT head_version FROM public.groups WHERE id = p_group;
$$;
CREATE FUNCTION pg_temp.code(p_group UUID) RETURNS TEXT LANGUAGE sql AS $$
    SELECT join_code FROM public.groups WHERE id = p_group;
$$;
CREATE FUNCTION pg_temp.member_of(p_user UUID, p_group UUID) RETURNS UUID LANGUAGE sql AS $$
    SELECT id FROM public.group_members WHERE user_id = p_user AND group_id = p_group;
$$;
CREATE FUNCTION pg_temp.guest_code(p_member UUID) RETURNS TEXT LANGUAGE sql AS $$
    SELECT code FROM public.guest_codes WHERE member_id = p_member AND deleted_at IS NULL;
$$;
-- As someone types it: lower case, with the dash in the middle.
CREATE FUNCTION pg_temp.typed(p_code TEXT) RETURNS TEXT LANGUAGE sql AS $$
    SELECT lower(substr(p_code, 1, length(p_code) / 2)) || '-' || lower(substr(p_code, length(p_code) / 2 + 1));
$$;
-- A code of the same length from the alphabet that differs from p_code.
CREATE FUNCTION pg_temp.other(p_code TEXT) RETURNS TEXT LANGUAGE sql AS $$
    SELECT CASE WHEN p_code = repeat('A', length(p_code)) THEN repeat('B', length(p_code)) ELSE repeat('A', length(p_code)) END;
$$;

-- ---------------------------------------------------------------------------
-- Users: aaaa… Alex, bbbb… Sam (emails); cccc… Gus, dddd… Gus's new phone, eeee… Kim, ffff… Ivy, 1111… Ann,
-- 2222… someone with Ann's code, 3333… Bo, 4444… Cy, 5555… Dee, 6666… Dee's new phone (anonymous).
-- Alex owns group 1 (Banff), group 2 (Jasper) and group 3 (Yoho).
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email, instance_id, aud, role, is_anonymous, raw_user_meta_data)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alex@personal.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Alex"}'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'sam@personal.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', FALSE, '{"display_name": "Sam"}'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('ffffffff-ffff-ffff-ffff-ffffffffffff', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('11111111-1111-1111-1111-111111111111', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('22222222-2222-2222-2222-222222222222', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('33333333-3333-3333-3333-333333333333', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('44444444-4444-4444-4444-444444444444', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('55555555-5555-5555-5555-555555555555', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}'),
    ('66666666-6666-6666-6666-666666666666', NULL, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', TRUE, '{}');

SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000001", "memberId": "20000000-0000-0000-0000-0000000000a1", "name": "Banff", "displayName": "Alex"}'), 'applied', 'Alex creates group 1');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000002", "memberId": "20000000-0000-0000-0000-0000000000a2", "name": "Jasper", "displayName": "Alex"}'), 'applied', 'Alex creates group 2');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.create", "groupId": "10000000-0000-0000-0000-000000000003", "memberId": "20000000-0000-0000-0000-0000000000a3", "name": "Yoho", "displayName": "Alex"}'), 'applied', 'Alex creates group 3');

SELECT is(pg_temp.join('cccccccc-cccc-cccc-cccc-cccccccccccc', pg_temp.code('10000000-0000-0000-0000-000000000001'), NULL, 'Gus'), '10000000-0000-0000-0000-000000000001'::UUID, 'Gus (a guest) joins group 1');
SELECT is(pg_temp.join('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', pg_temp.code('10000000-0000-0000-0000-000000000001'), NULL, 'Kim'), '10000000-0000-0000-0000-000000000001'::UUID, 'Kim (a guest) joins group 1');
SELECT pg_temp.member_of('cccccccc-cccc-cccc-cccc-cccccccccccc', '10000000-0000-0000-0000-000000000001') AS gus \gset
SELECT pg_temp.member_of('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '10000000-0000-0000-0000-000000000001') AS kim \gset
SELECT pg_temp.guest_code(:'gus'::UUID) AS gus_code \gset
SELECT pg_temp.guest_code(:'kim'::UUID) AS kim_code \gset

-- ---------------------------------------------------------------------------
-- 8 characters, unique across groups, apart from group codes
-- ---------------------------------------------------------------------------
SELECT ok(:'gus_code' ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$', 'a new guest''s personal code is 8 characters from the alphabet without lookalikes');
SELECT ok(:'kim_code' ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$', 'so is Kim''s');
SELECT isnt(:'gus_code'::TEXT, :'kim_code'::TEXT, 'and they differ');
SELECT ok(pg_temp.code('10000000-0000-0000-0000-000000000001') ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$', 'group codes stay 6 characters');
SELECT ok(private.new_personal_code() ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$', 'the generator makes 8-character codes');
SELECT is(
    (SELECT count(*)::INT FROM public.guest_codes c JOIN public.groups g ON g.join_code = c.code),
    0,
    'no personal code equals a group code'
);
SELECT throws_ok(
    format($$ INSERT INTO public.guest_codes (member_id, group_id, code) VALUES ('20000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000002', %L) $$, :'gus_code'),
    '23505', NULL, 'a live personal code can''t be used again, even in another group'
);
SELECT throws_ok(
    $$ INSERT INTO public.guest_codes (member_id, group_id, code) VALUES ('20000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000002', 'ABCDEF') $$,
    '23514', NULL, 'a 6-character personal code is refused by the table'
);

-- ---------------------------------------------------------------------------
-- preview_code: what a code is
-- ---------------------------------------------------------------------------
SELECT is(
    pg_temp.preview_signed_out(pg_temp.typed(pg_temp.code('10000000-0000-0000-0000-000000000001'))),
    jsonb_build_object('kind', 'group') || pg_temp.group_preview_signed_out(pg_temp.code('10000000-0000-0000-0000-000000000001')),
    'signed out, a group code (lower case, with its dash) is a group, with preview_group''s fields'
);
SELECT is(
    pg_temp.preview_signed_out(pg_temp.typed(:'gus_code')),
    jsonb_build_object(
        'kind', 'personal',
        'groupId', '10000000-0000-0000-0000-000000000001',
        'groupName', 'Banff',
        'displayName', 'Gus',
        'alreadyMember', FALSE
    ),
    'signed out, Gus''s personal code (lower case, with its dash) is Gus in Banff'
);
SELECT is((pg_temp.preview('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', :'gus_code')->>'alreadyMember')::BOOLEAN, TRUE, 'Alex, in the group, is told he is already in it');
SELECT is(pg_temp.preview_error(pg_temp.other(:'gus_code')), 'HS404 This code doesn''t work', 'an unknown 8-character code doesn''t work');
SELECT is(pg_temp.preview_error(pg_temp.other(pg_temp.code('10000000-0000-0000-0000-000000000001'))), 'HS404 This code doesn''t work', 'nor does an unknown 6-character one');
SELECT is(pg_temp.preview_error(substr(:'gus_code', 1, 7)), 'HS404 This code doesn''t work', 'nor 7 characters');
SELECT is(pg_temp.preview_error(''), 'HS404 This code doesn''t work', 'nor nothing');
SELECT is(pg_temp.preview_error(substr(:'gus_code', 1, 6)), 'HS404 This code doesn''t work', 'the first 6 characters of a personal code are not a group code');
SELECT is(pg_temp.sqlstate_signed_out($$ SELECT public.return_with_code('ABCDEFGH') $$), '42501', 'signed out, return_with_code can''t be called');

-- ---------------------------------------------------------------------------
-- return_with_code: Gus on a new phone
-- ---------------------------------------------------------------------------
SELECT pg_temp.head('10000000-0000-0000-0000-000000000001') AS before_return \gset
SELECT is(
    pg_temp.return('dddddddd-dddd-dddd-dddd-dddddddddddd', pg_temp.typed(:'gus_code')),
    '10000000-0000-0000-0000-000000000001'::UUID,
    'Gus''s new phone, with his code alone (lower case, with the dash), gets the group id back'
);
SELECT results_eq(
    format($$ SELECT user_id::TEXT, role, row_version, display_name FROM public.group_members WHERE id = %L $$, :'gus'),
    $$ VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'guest', pg_temp.head('10000000-0000-0000-0000-000000000001'), 'Gus') $$,
    'Gus''s row moved to the new login, still a guest named Gus, at the group''s latest version'
);
SELECT is(pg_temp.head('10000000-0000-0000-0000-000000000001'), :before_return::BIGINT + 1, 'in one new version');
SELECT is(pg_temp.guest_code(:'gus'::UUID), :'gus_code', 'Gus keeps the same code');
SELECT is(
    (SELECT count(*)::INT FROM public.guest_handoffs WHERE member_id = :'gus'::UUID AND from_user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
    1,
    'the handoff from the old login is recorded'
);
SELECT is(pg_temp.pull('cccccccc-cccc-cccc-cccc-cccccccccccc')->'group_ids', '[]'::JSONB, 'the old phone no longer pulls the group');
SELECT is(pg_temp.pull('cccccccc-cccc-cccc-cccc-cccccccccccc')->'moved_away', '["10000000-0000-0000-0000-000000000001"]'::JSONB, 'and is told it moved away');
SELECT is(pg_temp.pull('dddddddd-dddd-dddd-dddd-dddddddddddd')->'group_ids', '["10000000-0000-0000-0000-000000000001"]'::JSONB, 'the new phone pulls the group');
SELECT is(pg_temp.pull('dddddddd-dddd-dddd-dddd-dddddddddddd')->'moved_away', '[]'::JSONB, 'with nothing moved away from it');
SELECT is((pg_temp.preview('dddddddd-dddd-dddd-dddd-dddddddddddd', :'gus_code')->>'alreadyMember')::BOOLEAN, TRUE, 'the code now shows the new phone it is already in');

SELECT pg_temp.head('10000000-0000-0000-0000-000000000001') AS after_return \gset
SELECT is(pg_temp.return('dddddddd-dddd-dddd-dddd-dddddddddddd', :'gus_code'), '10000000-0000-0000-0000-000000000001'::UUID, 'returning again gives the group id');
SELECT is(pg_temp.head('10000000-0000-0000-0000-000000000001'), :after_return::BIGINT, 'and changes nothing');
SELECT is(pg_temp.return('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', :'gus_code'), '10000000-0000-0000-0000-000000000001'::UUID, 'Alex, already in the group, with Gus''s code gets the group id');
SELECT is(pg_temp.head('10000000-0000-0000-0000-000000000001'), :after_return::BIGINT, 'without taking Gus''s name');
SELECT is((SELECT user_id::TEXT FROM public.group_members WHERE id = :'gus'::UUID), 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'Gus is still on the new phone');

-- ---------------------------------------------------------------------------
-- Someone who left
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.try('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', jsonb_build_object('type', 'member.remove', 'groupId', '10000000-0000-0000-0000-000000000001', 'memberId', :'kim')), 'applied', 'Kim leaves group 1');
SELECT is(pg_temp.preview_error(:'kim_code'), 'HS404 This code doesn''t work', 'Kim''s code doesn''t work once she has left');
SELECT is(pg_temp.return_error('ffffffff-ffff-ffff-ffff-ffffffffffff', :'kim_code'), 'HS404 This code doesn''t work', 'nor for getting back in');

-- Kim, with her old left row, takes Gus's name: her old row lets go of her login.
SELECT is(pg_temp.return('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', :'gus_code'), '10000000-0000-0000-0000-000000000001'::UUID, 'Kim''s login, which left the group, comes back with Gus''s code');
SELECT results_eq(
    format($$ SELECT id::TEXT, user_id IS NULL, deleted_at IS NOT NULL FROM public.group_members WHERE id IN (%L, %L) ORDER BY id = %L $$, :'kim', :'gus', :'gus'),
    format($$ VALUES (%L, TRUE, TRUE), (%L, FALSE, FALSE) $$, :'kim', :'gus'),
    'Kim''s old row has no login now; Gus''s row is active'
);
SELECT is((SELECT user_id::TEXT FROM public.group_members WHERE id = :'gus'::UUID), 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'and is Kim''s login');
SELECT is(pg_temp.pull('dddddddd-dddd-dddd-dddd-dddddddddddd')->'moved_away', '["10000000-0000-0000-0000-000000000001"]'::JSONB, 'the phone it left is told it moved away');

-- ---------------------------------------------------------------------------
-- Coming back with an email login: a member, the code goes
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.return('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', :'gus_code'), '10000000-0000-0000-0000-000000000001'::UUID, 'Sam (with an email) comes back with Gus''s code');
SELECT results_eq(
    format($$ SELECT gm.user_id::TEXT, gm.role, c.deleted_at IS NOT NULL, c.row_version = gm.row_version FROM public.group_members gm JOIN public.guest_codes c ON c.member_id = gm.id WHERE gm.id = %L $$, :'gus'),
    $$ VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member', TRUE, TRUE) $$,
    'Gus''s row is a member with Sam''s login, and the code is deleted in the same version'
);
SELECT is(pg_temp.pull('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')->'moved_away', '["10000000-0000-0000-0000-000000000001"]'::JSONB, 'Kim''s login is told it moved away');
SELECT is(pg_temp.preview_error(:'gus_code'), 'HS404 This code doesn''t work', 'the code doesn''t work any more');

-- ---------------------------------------------------------------------------
-- After adding an email, the code is gone
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.join('ffffffff-ffff-ffff-ffff-ffffffffffff', pg_temp.code('10000000-0000-0000-0000-000000000001'), NULL, 'Ivy'), '10000000-0000-0000-0000-000000000001'::UUID, 'Ivy (a guest) joins group 1');
SELECT pg_temp.guest_code(pg_temp.member_of('ffffffff-ffff-ffff-ffff-ffffffffffff', '10000000-0000-0000-0000-000000000001')) AS ivy_code \gset
SELECT is(pg_temp.preview_error(:'ivy_code'), 'ok', 'Ivy''s code works');
UPDATE auth.users SET email = 'ivy@personal.test', is_anonymous = FALSE WHERE id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
SELECT lives_ok($$ SELECT pg_temp.upgrade('ffffffff-ffff-ffff-ffff-ffffffffffff') $$, 'Ivy adds an email');
SELECT is(pg_temp.preview_error(:'ivy_code'), 'HS404 This code doesn''t work', 'her code doesn''t work any more');
SELECT is(pg_temp.return_error('22222222-2222-2222-2222-222222222222', :'ivy_code'), 'HS404 This code doesn''t work', 'nor for getting back in');

-- ---------------------------------------------------------------------------
-- The guard: a code never belongs to someone with an email, but if it did, it would not take their name
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.join('11111111-1111-1111-1111-111111111111', pg_temp.code('10000000-0000-0000-0000-000000000001'), NULL, 'Ann'), '10000000-0000-0000-0000-000000000001'::UUID, 'Ann (a guest) joins group 1');
SELECT pg_temp.member_of('11111111-1111-1111-1111-111111111111', '10000000-0000-0000-0000-000000000001') AS ann \gset
SELECT pg_temp.guest_code(:'ann'::UUID) AS ann_code \gset
ALTER TABLE public.group_members DISABLE TRIGGER group_members_drop_guest_code;
UPDATE public.group_members SET role = 'member' WHERE id = :'ann'::UUID;
ALTER TABLE public.group_members ENABLE TRIGGER group_members_drop_guest_code;
SELECT is(pg_temp.return_error('22222222-2222-2222-2222-222222222222', :'ann_code'), 'HS422 Sign in with your email to get back in', 'a live code on a member''s row is refused');
SELECT is(pg_temp.preview_error(:'ann_code'), 'HS404 This code doesn''t work', 'and doesn''t show');
SELECT is((SELECT user_id::TEXT FROM public.group_members WHERE id = :'ann'::UUID), '11111111-1111-1111-1111-111111111111', 'Ann keeps her row');

-- ---------------------------------------------------------------------------
-- A deleted group, a completed group
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.join('33333333-3333-3333-3333-333333333333', pg_temp.code('10000000-0000-0000-0000-000000000002'), NULL, 'Bo'), '10000000-0000-0000-0000-000000000002'::UUID, 'Bo (a guest) joins group 2');
SELECT pg_temp.guest_code(pg_temp.member_of('33333333-3333-3333-3333-333333333333', '10000000-0000-0000-0000-000000000002')) AS bo_code \gset
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.delete", "groupId": "10000000-0000-0000-0000-000000000002"}'), 'applied', 'Alex deletes group 2');
SELECT is(pg_temp.preview_error(:'bo_code'), 'HS404 This code doesn''t work', 'Bo''s code doesn''t work in a deleted group');
SELECT is(pg_temp.return_error('22222222-2222-2222-2222-222222222222', :'bo_code'), 'HS404 This code doesn''t work', 'nor for getting back in');

SELECT is(pg_temp.join('44444444-4444-4444-4444-444444444444', pg_temp.code('10000000-0000-0000-0000-000000000003'), NULL, 'Cy'), '10000000-0000-0000-0000-000000000003'::UUID, 'Cy (a guest) joins group 3');
SELECT pg_temp.guest_code(pg_temp.member_of('44444444-4444-4444-4444-444444444444', '10000000-0000-0000-0000-000000000003')) AS cy_code \gset
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.complete", "groupId": "10000000-0000-0000-0000-000000000003"}'), 'applied', 'Alex completes group 3');
SELECT is(pg_temp.preview_error(:'cy_code'), 'HS404 This code doesn''t work', 'Cy''s code doesn''t work in a completed group');
SELECT is(pg_temp.return_error('22222222-2222-2222-2222-222222222222', :'cy_code'), 'HS404 This code doesn''t work', 'nor for getting back in');
SELECT is(pg_temp.try('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"type": "group.reopen", "groupId": "10000000-0000-0000-0000-000000000003"}'), 'applied', 'Alex reopens it');
SELECT is(pg_temp.preview_error(:'cy_code'), 'HS404 This code doesn''t work', 'the code stays gone: completing deleted it');

-- ---------------------------------------------------------------------------
-- join_with_code's come-back path takes 8-character codes
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.join('55555555-5555-5555-5555-555555555555', pg_temp.code('10000000-0000-0000-0000-000000000001'), NULL, 'Dee'), '10000000-0000-0000-0000-000000000001'::UUID, 'Dee (a guest) joins group 1');
SELECT pg_temp.member_of('55555555-5555-5555-5555-555555555555', '10000000-0000-0000-0000-000000000001') AS dee \gset
SELECT pg_temp.guest_code(:'dee'::UUID) AS dee_code \gset
SELECT is(
    pg_temp.join_error('66666666-6666-6666-6666-666666666666', pg_temp.code('10000000-0000-0000-0000-000000000001'), :'dee'::UUID, NULL, substr(:'dee_code', 1, 6)),
    'HS422 That code doesn''t match',
    'a 6-character code no longer matches'
);
SELECT is(
    pg_temp.join('66666666-6666-6666-6666-666666666666', pg_temp.code('10000000-0000-0000-0000-000000000001'), :'dee'::UUID, NULL, pg_temp.typed(:'dee_code')),
    '10000000-0000-0000-0000-000000000001'::UUID,
    'Dee''s new phone picks Dee and types her 8-character code'
);
SELECT is((SELECT user_id::TEXT FROM public.group_members WHERE id = :'dee'::UUID), '66666666-6666-6666-6666-666666666666', 'and is Dee');
SELECT is(pg_temp.pull('55555555-5555-5555-5555-555555555555')->'moved_away', '["10000000-0000-0000-0000-000000000001"]'::JSONB, 'Dee''s old phone is told it moved away');

-- ---------------------------------------------------------------------------
-- Replacing old 6-character codes (as 013 did on its way in)
-- ---------------------------------------------------------------------------
ALTER TABLE public.guest_codes DROP CONSTRAINT guest_codes_code_check;
UPDATE public.guest_codes SET code = 'HX7K2P' WHERE member_id = :'dee'::UUID;
UPDATE public.guest_codes SET code = 'HX7K2Q' WHERE member_id = :'kim'::UUID;
SELECT pg_temp.head('10000000-0000-0000-0000-000000000001') AS before_renew \gset
SELECT pg_temp.head('10000000-0000-0000-0000-000000000003') AS before_renew_3 \gset
SELECT lives_ok($$ SELECT private.renew_short_guest_codes() $$, 'old codes are replaced');
SELECT is(pg_temp.head('10000000-0000-0000-0000-000000000001'), :before_renew::BIGINT + 1, 'in one new version for the group');
SELECT is(pg_temp.head('10000000-0000-0000-0000-000000000003'), :before_renew_3::BIGINT, 'a group without old codes is left alone');
SELECT results_eq(
    format($$ SELECT code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$', row_version = pg_temp.head('10000000-0000-0000-0000-000000000001') FROM public.guest_codes WHERE member_id IN (%L, %L) $$, :'dee', :'kim'),
    $$ VALUES (TRUE, TRUE), (TRUE, TRUE) $$,
    'both (live and deleted) are 8 characters now, stamped with that version'
);
SELECT is(pg_temp.guest_code(:'ann'::UUID), :'ann_code', 'an 8-character code is kept');
SELECT is(
    (SELECT gc->>'code' FROM jsonb_array_elements(pg_temp.pull('66666666-6666-6666-6666-666666666666', jsonb_build_object('10000000-0000-0000-0000-000000000001', :before_renew::BIGINT))->'changes') c,
        jsonb_array_elements(c->'guest_codes') gc WHERE gc->>'member_id' = :'dee'),
    pg_temp.guest_code(:'dee'::UUID),
    'Dee''s device, already past the old code, pulls the new one'
);
SELECT is(pg_temp.preview_error(pg_temp.guest_code(:'dee'::UUID)), 'ok', 'which works');
SELECT is(pg_temp.preview_error('HX7K2P'), 'HS404 This code doesn''t work', 'and the old one doesn''t');
SELECT pg_temp.head('10000000-0000-0000-0000-000000000001') AS after_renew \gset
SELECT lives_ok($$ SELECT private.renew_short_guest_codes() $$, 'running it again');
SELECT is(pg_temp.head('10000000-0000-0000-0000-000000000001'), :after_renew::BIGINT, 'changes nothing');

SELECT * FROM finish();
ROLLBACK;
